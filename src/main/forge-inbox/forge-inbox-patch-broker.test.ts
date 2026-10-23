import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256OfContent, type ForgePatchOperation } from './forge-inbox-patch-draft'
import { approveForgePatch, createForgePatchProposal } from './forge-inbox-patch-proposal'
import { applyForgePatchProposal } from './forge-inbox-patch-broker'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchPathContent, ForgePatchSource } from './forge-inbox-patch-tree'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const BASE = 'a'.repeat(40)
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }
const OPERATIONS: ForgePatchOperation[] = [
  {
    op: 'update',
    path: 'src/a.ts',
    baseSha256: sha256OfContent('old\n'),
    content: 'new\n',
    resultSha256: sha256OfContent('new\n')
  },
  { op: 'create', path: 'src/b.ts', content: 'b\n', resultSha256: sha256OfContent('b\n') }
]

function project(overrides: Record<string, unknown> = {}) {
  return { projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true, ...overrides }
}

function sourceOf(paths: Record<string, ForgePatchPathContent>): ForgePatchSource {
  return { readPath: async (path) => paths[path] ?? { kind: 'missing' } }
}

describe('forge patch broker', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let parent: string

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [project()] })]))
    parent = mkdtempSync(join(tmpdir(), 'forge-patch-broker-'))
  })
  afterEach(() => {
    ledger.close()
    harness.dispose()
    rmSync(parent, { recursive: true, force: true })
  })

  function runningRun() {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: '42',
        kind: 'merge_request',
        iid: 7,
        dedupeKey: 'd-1',
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: 'sha256:v1',
        queueRun: { reason: 'review-request' }
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!observed.ok || observed.duplicate || observed.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(observed)}`)
    }
    ledger.transitionRun(observed.runId, { to: 'running' })
    const run = ledger.getRun(observed.runId)
    if (!run) {
      throw new Error('run vanished')
    }
    return run
  }

  function createPatch(): { proposalId: number; hash: string } {
    const run = runningRun()
    const created = createForgePatchProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.id,
        expectedGeneration: run.generation,
        draft: { target: TARGET, baseSha: BASE, branch: 'main', operations: OPERATIONS }
      }
    )
    if (!created.ok) {
      throw new Error(`unexpected refusal ${created.reason}`)
    }
    return { proposalId: created.proposal.id, hash: created.hash }
  }

  async function approve(proposalId: number, hash: string): Promise<void> {
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }
    const approved = await approveForgePatch(
      { ledger, readHead: async () => ({ ok: true, sha: BASE }) },
      {
        scope: SCOPE,
        proposalId,
        expectedHash: hash,
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      new AbortController().signal
    )
    if (!approved.ok) {
      throw new Error(`unexpected approval failure ${approved.reason}`)
    }
  }

  function apply(proposalId: number, hash: string, source: ForgePatchSource, signal?: AbortSignal) {
    return applyForgePatchProposal(
      { ledger, source: () => source, parentDirectory: parent },
      { scope: SCOPE, proposalId, expectedHash: hash },
      signal ?? new AbortController().signal
    )
  }

  it('applies an approved patch once and records the receipt', async () => {
    const { proposalId, hash } = createPatch()
    await approve(proposalId, hash)

    const result = await apply(
      proposalId,
      hash,
      sourceOf({ 'src/a.ts': { kind: 'file', content: 'old\n' } })
    )

    if (result.kind !== 'applied') {
      throw new Error(`unexpected result ${JSON.stringify(result)}`)
    }
    expect(readFileSync(join(result.directory, 'src/a.ts'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(result.directory, 'src/b.ts'), 'utf8')).toBe('b\n')
    expect(result.written).toEqual(['src/a.ts', 'src/b.ts'])

    const replay = await apply(
      proposalId,
      hash,
      sourceOf({ 'src/a.ts': { kind: 'file', content: 'old\n' } })
    )
    expect(replay).toEqual({ kind: 'refused', reason: 'already-applied' })
    expect(readdirSync(parent)).toHaveLength(1)
  })

  it('refuses a patch nobody approved', async () => {
    const { proposalId, hash } = createPatch()

    await expect(
      apply(proposalId, hash, sourceOf({ 'src/a.ts': { kind: 'file', content: 'old\n' } }))
    ).resolves.toEqual({ kind: 'refused', reason: 'not-approved' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('refuses a hash the client did not see', async () => {
    const { proposalId, hash } = createPatch()
    await approve(proposalId, hash)

    await expect(apply(proposalId, 'f'.repeat(64), sourceOf({}))).resolves.toEqual({
      kind: 'refused',
      reason: 'draft-mismatch'
    })
  })

  it('refuses a proposal whose body is not a patch', async () => {
    const run = runningRun()
    const created = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: { kind: 'comment', body: 'Looks good.' }
    })
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(apply(created.proposal.id, 'f'.repeat(64), sourceOf({}))).resolves.toEqual({
      kind: 'refused',
      reason: 'not-a-patch'
    })
  })

  it('refuses a proposal from another instance scope', async () => {
    const { proposalId, hash } = createPatch()
    await approve(proposalId, hash)

    await expect(
      applyForgePatchProposal(
        { ledger, source: () => sourceOf({}), parentDirectory: parent },
        { scope: { instanceId: 'gitlab-other' }, proposalId, expectedHash: hash },
        new AbortController().signal
      )
    ).resolves.toEqual({ kind: 'refused', reason: 'not-found' })
  })

  it('records a failure without leaving a tree when the base is unusable', async () => {
    const { proposalId, hash } = createPatch()
    await approve(proposalId, hash)

    const result = await apply(proposalId, hash, sourceOf({ 'src/a.ts': { kind: 'unavailable' } }))

    expect(result).toMatchObject({ kind: 'failed', reason: 'source-unavailable' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('records a cancelled run as a failure', async () => {
    const { proposalId, hash } = createPatch()
    await approve(proposalId, hash)
    const controller = new AbortController()
    controller.abort()

    await expect(
      apply(
        proposalId,
        hash,
        sourceOf({ 'src/a.ts': { kind: 'file', content: 'old\n' } }),
        controller.signal
      )
    ).resolves.toMatchObject({ kind: 'failed', reason: 'aborted' })
    expect(readdirSync(parent)).toEqual([])
  })
})
