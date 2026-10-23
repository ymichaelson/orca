import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveForgePush,
  buildForgePushPlan,
  createForgePushProposal,
  hashForgePushPlan,
  parseForgePushPlan,
  type ForgePushPlan
} from './forge-inbox-push-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchHeadReader } from './forge-inbox-patch-proposal'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const TARGET = { instanceId: INSTANCE_ID, projectId: '42' }
const BASE = '751b7ab0bde8ffcd0519ed2acb1a9063dacf6c82'
const NEXT_BASE = 'b'.repeat(40)
const TREE = '2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1'
const COMMIT = '701fcb9c590fd7dc034d0d60847961a76daddd23'
const IDENTITY = {
  name: 'Orca',
  email: 'orca@example.com',
  timeSeconds: 1700000000,
  timezone: '+0000'
}

type PlanInput = Omit<ForgePushPlan, 'kind' | 'commitSha'>

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    target: TARGET,
    branch: 'main',
    expectedHeadSha: BASE,
    treeSha: TREE,
    commit: { author: IDENTITY, committer: IDENTITY, message: 'Forge change\n' },
    ...overrides
  }
}

function storedHash(body: unknown): string {
  const plan = parseForgePushPlan(body)
  if (!plan) {
    throw new Error('stored proposal is not a push plan')
  }
  return hashForgePushPlan(plan)
}

function project(overrides: Record<string, unknown> = {}) {
  return { projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true, ...overrides }
}

describe('forge inbox push proposal', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [project()] })]))
  })
  afterEach(() => {
    ledger.close()
    harness.dispose()
  })

  function runningRun(): { runId: number; generation: number } {
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
    return { runId: run.id, generation: run.generation }
  }

  function createPush(options: { overrides?: Partial<PlanInput>; generation?: number } = {}) {
    const run = runningRun()
    const built = buildForgePushPlan(planInput(options.overrides))
    if (!built.ok) {
      throw new Error(`plan rejected: ${built.reason}`)
    }
    return createForgePushProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: options.generation ?? run.generation,
        plan: built.plan
      }
    )
  }

  function headReader(read: ForgePatchHeadReader = async () => ({ ok: true, sha: BASE })) {
    return vi.fn(read)
  }

  function approve(
    proposalId: number,
    options: {
      hash?: string
      revision?: number
      policyGeneration?: number
      readHead?: ReturnType<typeof headReader>
    } = {}
  ) {
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }
    return approveForgePush(
      { ledger, readHead: options.readHead ?? headReader() },
      {
        scope: SCOPE,
        proposalId,
        expectedHash: options.hash ?? storedHash(proposal.body),
        expectedRevision: options.revision ?? proposal.revision,
        expectedPolicyGeneration: options.policyGeneration ?? proposal.policyGeneration
      },
      new AbortController().signal
    )
  }

  it('stores the exact plan, its commit id and its hash', () => {
    const result = createPush()
    if (!result.ok) {
      throw new Error(`unexpected refusal ${result.reason}`)
    }

    expect(result.plan.commitSha).toBe(COMMIT)
    expect(result.proposal.status).toBe('pending')
    expect(result.proposal.body).toEqual(result.plan)
    expect(result.hash).toBe(hashForgePushPlan(result.plan))
  })

  it('refuses a plan aimed at another project than the run analysed', () => {
    expect(
      createPush({ overrides: { target: { instanceId: INSTANCE_ID, projectId: '43' } } })
    ).toEqual({ ok: false, reason: 'item-mismatch' })
  })

  it('refuses to create when the run generation moved', () => {
    expect(createPush({ generation: 99 })).toEqual({ ok: false, reason: 'generation-mismatch' })
  })

  it('refuses an unsafe branch or an unpinned head', () => {
    expect(buildForgePushPlan(planInput({ branch: '../main' }))).toEqual({
      ok: false,
      reason: 'branch-invalid'
    })
    expect(buildForgePushPlan(planInput({ expectedHeadSha: 'abc' }))).toEqual({
      ok: false,
      reason: 'base-invalid'
    })
    expect(buildForgePushPlan(planInput({ treeSha: 'abc' }))).toEqual({
      ok: false,
      reason: 'tree-invalid'
    })
  })

  it('refuses a body that claims a different commit id than its fields produce', () => {
    const result = createPush()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }

    expect(parseForgePushPlan({ ...result.plan, commitSha: 'f'.repeat(40) })).toBeNull()
    expect(parseForgePushPlan(result.plan)).not.toBeNull()
  })

  it('supersedes the pending push when a newer one targets the same item', () => {
    const run = runningRun()
    const build = (message: string) => {
      const built = buildForgePushPlan(
        planInput({ commit: { author: IDENTITY, committer: IDENTITY, message } })
      )
      if (!built.ok) {
        throw new Error(`plan rejected: ${built.reason}`)
      }
      return createForgePushProposal(
        { ledger },
        { scope: SCOPE, runId: run.runId, expectedGeneration: run.generation, plan: built.plan }
      )
    }
    const first = build('First\n')
    const second = build('Second\n')
    if (!first.ok || !second.ok) {
      throw new Error('unexpected refusal')
    }

    expect(ledger.getProposal(first.proposal.id)?.status).toBe('stale')
    expect(ledger.getProposal(second.proposal.id)?.status).toBe('pending')
  })

  it('refuses a hash the client did not actually see, before reading the branch head', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader()

    const result = await approve(created.proposal.id, {
      hash: 'f'.repeat(64),
      readHead
    })

    expect(result).toEqual({ ok: false, reason: 'draft-mismatch' })
    expect(readHead).not.toHaveBeenCalled()
  })

  it('marks the push stale when the branch head moved', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader(async () => ({ ok: true, sha: NEXT_BASE }))

    const result = await approve(created.proposal.id, { readHead })

    expect(result).toEqual({ ok: false, reason: 'head-moved' })
    expect(readHead).toHaveBeenCalledWith(
      { instanceId: INSTANCE_ID, projectId: '42', branch: 'main' },
      expect.any(AbortSignal)
    )
    expect(ledger.getProposal(created.proposal.id)?.status).toBe('stale')
  })

  it('keeps the push pending when the branch head cannot be read', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader(async () => ({ ok: false, code: 'network' }))

    await expect(approve(created.proposal.id, { readHead })).resolves.toEqual({
      ok: false,
      reason: 'head-unavailable'
    })
    expect(ledger.getProposal(created.proposal.id)?.status).toBe('pending')
    await expect(approve(created.proposal.id)).resolves.toMatchObject({ ok: true })
  })

  it('consumes the approval exactly once', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(approve(created.proposal.id)).resolves.toMatchObject({ ok: true })
    await expect(approve(created.proposal.id)).resolves.toEqual({
      ok: false,
      reason: 'not-pending'
    })
  })

  it('refuses an approval for an item version that has already moved', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(approve(created.proposal.id, { revision: 99 })).resolves.toEqual({
      ok: false,
      reason: 'stale'
    })
  })

  it('refuses a proposal whose body is not a push plan', async () => {
    const run = runningRun()
    const created = ledger.createProposal({
      runId: run.runId,
      expectedGeneration: run.generation,
      body: { kind: 'comment', body: 'Looks good.' }
    })
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(approve(created.proposal.id, { hash: 'f'.repeat(64) })).resolves.toEqual({
      ok: false,
      reason: 'not-a-push'
    })
  })

  it('refuses an approval from another instance scope', async () => {
    const created = createPush()
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }
    const proposal = ledger.getProposal(created.proposal.id)
    if (!proposal) {
      throw new Error('proposal vanished')
    }

    await expect(
      approveForgePush(
        { ledger, readHead: headReader() },
        {
          scope: { instanceId: 'gitlab-other' },
          proposalId: created.proposal.id,
          expectedHash: storedHash(proposal.body),
          expectedRevision: proposal.revision,
          expectedPolicyGeneration: proposal.policyGeneration
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
  })
})
