import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256OfContent, type ForgePatchOperation } from './forge-inbox-patch-draft'
import { approveAndApplyForgePatch } from './forge-inbox-patch-apply'
import { createForgePatchProposal } from './forge-inbox-patch-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchHead } from './forge-inbox-patch-proposal'
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

function files() {
  return sourceOf({ 'src/a.ts': { kind: 'file', content: 'old\n' } })
}

describe('forge patch approval and apply', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let parent: string

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [project()] })]))
    parent = mkdtempSync(join(tmpdir(), 'forge-patch-apply-'))
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

  function createPatch(): {
    proposalId: number
    hash: string
    revision: number
    generation: number
  } {
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
    return {
      proposalId: created.proposal.id,
      hash: created.hash,
      revision: created.proposal.revision,
      generation: created.proposal.policyGeneration
    }
  }

  async function run(
    input: {
      proposalId: number
      hash: string
      scope?: { instanceId: string }
      revision?: number
      generation?: number
    },
    options: { head?: ForgePatchHead; source?: ForgePatchSource; signal?: AbortSignal } = {}
  ) {
    let headCalls = 0
    let sourceCalls = 0
    const result = await approveAndApplyForgePatch(
      {
        ledger,
        readHead: async () => {
          headCalls += 1
          return options.head ?? { ok: true, sha: BASE }
        },
        source: () => {
          sourceCalls += 1
          return options.source ?? files()
        },
        parentDirectory: parent
      },
      {
        scope: input.scope ?? SCOPE,
        proposalId: input.proposalId,
        expectedHash: input.hash,
        expectedRevision: input.revision ?? ledger.getProposal(input.proposalId)?.revision ?? 0,
        expectedPolicyGeneration:
          input.generation ?? ledger.getProposal(input.proposalId)?.policyGeneration ?? 0
      },
      options.signal ?? new AbortController().signal
    )
    return { result, headCalls, sourceCalls }
  }

  it('approves the shown draft and materialises it in one call', async () => {
    const patch = createPatch()

    const { result } = await run(patch)

    if (!result.ok) {
      throw new Error(`unexpected result ${JSON.stringify(result)}`)
    }
    expect(result.written).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.removed).toEqual([])
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('consumed')
    const directories = readdirSync(parent)
    expect(directories).toHaveLength(1)
    const directory = join(parent, directories[0])
    expect(readFileSync(join(directory, 'src/a.ts'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(directory, 'src/b.ts'), 'utf8')).toBe('b\n')
  })

  it('refuses a hash the owner never displayed without consuming the proposal', async () => {
    const patch = createPatch()

    const { result, headCalls, sourceCalls } = await run({ ...patch, hash: 'f'.repeat(64) })

    expect(result).toEqual({ ok: false, reason: 'draft-mismatch' })
    expect(headCalls).toBe(0)
    expect(sourceCalls).toBe(0)
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('pending')
    expect(readdirSync(parent)).toEqual([])
  })

  it('binds the exact revision and policy generation the client saw', async () => {
    const patch = createPatch()

    const { result, headCalls } = await run({ ...patch, revision: patch.revision + 1 })

    expect(result).toEqual({ ok: false, reason: 'stale' })
    expect(headCalls).toBe(0)
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('pending')
    expect(readdirSync(parent)).toEqual([])
  })

  it('makes a moved branch head stale instead of applying to the old base', async () => {
    const patch = createPatch()

    const { result } = await run(patch, { head: { ok: true, sha: 'b'.repeat(40) } })

    expect(result).toEqual({ ok: false, reason: 'head-moved' })
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('stale')
    expect(readdirSync(parent)).toEqual([])
  })

  it('leaves the approval pending when the head cannot be read', async () => {
    const patch = createPatch()

    const { result } = await run(patch, { head: { ok: false, code: 'network' } })

    expect(result).toEqual({ ok: false, reason: 'head-unavailable' })
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('pending')
    expect(readdirSync(parent)).toEqual([])
  })

  it('treats another instance scope as a missing proposal', async () => {
    const patch = createPatch()

    const { result, sourceCalls } = await run({ ...patch, scope: { instanceId: 'gitlab-other' } })

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(sourceCalls).toBe(0)
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('pending')
  })

  it('refuses a proposal whose body is not a patch', async () => {
    const liveRun = runningRun()
    const created = ledger.createProposal({
      runId: liveRun.id,
      expectedGeneration: liveRun.generation,
      body: { kind: 'comment', body: 'Looks good.' }
    })
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    const { result } = await run({ proposalId: created.proposal.id, hash: 'f'.repeat(64) })

    expect(result).toEqual({ ok: false, reason: 'not-a-patch' })
  })

  it('reports a failed build with its receipt and leaves no tree', async () => {
    const patch = createPatch()

    const { result } = await run(patch, {
      source: sourceOf({ 'src/a.ts': { kind: 'unavailable' } })
    })

    expect(result).toMatchObject({ ok: false, reason: 'source-unavailable' })
    expect(result.ok).toBe(false)
    expect('receiptId' in result && Number.isSafeInteger(result.receiptId)).toBe(true)
    expect(ledger.getProposal(patch.proposalId)?.status).toBe('consumed')
    expect(readdirSync(parent)).toEqual([])
  })

  it('records a cancelled build as a failure rather than an unknown outcome', async () => {
    const patch = createPatch()
    const controller = new AbortController()
    controller.abort()

    const { result } = await run(patch, { signal: controller.signal })

    expect(result).toMatchObject({ ok: false, reason: 'aborted' })
    expect(readdirSync(parent)).toEqual([])
  })
})
