import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveForgePush,
  buildForgePushPlan,
  hashForgePushPlan,
  parseForgePushPlan,
  type ForgePushPlan
} from './forge-inbox-push-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgePatchHeadReader } from './forge-inbox-patch-proposal'
import { buildForgePatchDraft, sha256OfContent } from './forge-inbox-patch-draft'
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
type PatchSource = { runId: number; proposalId: number; hash: string }

function planInput(
  patch: { proposalId: number; hash: string },
  overrides: Partial<PlanInput> = {}
) {
  return {
    patch,
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

  function runningRun(dedupeKey = 'd-1'): { runId: number; generation: number } {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: '42',
        kind: 'merge_request',
        iid: 7,
        dedupeKey,
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: `sha256:${dedupeKey}`,
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

  /** A push may only publish a patch the owner consumed and the broker applied. */
  function patchProposal(
    runId: number,
    generation: number,
    settle: 'applied' | 'failed' | 'pending' = 'applied'
  ): PatchSource {
    const built = buildForgePatchDraft({
      target: TARGET,
      baseSha: BASE,
      branch: 'main',
      operations: [
        {
          op: 'update',
          path: 'a.txt',
          baseSha256: sha256OfContent('hello\n'),
          content: 'world\n',
          resultSha256: sha256OfContent('world\n')
        }
      ]
    })
    if (!built.ok) {
      throw new Error(`draft rejected: ${built.reason}`)
    }
    const created = ledger.createProposal({
      runId,
      expectedGeneration: generation,
      body: built.draft
    })
    if (!created.ok) {
      throw new Error(`patch proposal rejected: ${created.reason}`)
    }
    if (settle !== 'pending') {
      const consumed = ledger.consumeProposal(created.proposal.id, {
        revision: created.proposal.revision,
        policyGeneration: created.proposal.policyGeneration
      })
      if (!consumed.ok) {
        throw new Error(`patch not consumed: ${consumed.reason}`)
      }
      const begun = ledger.beginReceipt({ proposalId: created.proposal.id })
      if (!begun.started) {
        throw new Error('patch receipt did not start')
      }
      ledger.finishReceipt(begun.receipt.id, { state: settle })
    }
    return { runId, proposalId: created.proposal.id, hash: built.hash }
  }

  function appliedPatch(): PatchSource {
    const run = runningRun()
    return patchProposal(run.runId, run.generation)
  }

  function createPush(options: { overrides?: Partial<PlanInput>; patch?: PatchSource } = {}) {
    const patch = options.patch ?? appliedPatch()
    const plan = planInput({ proposalId: patch.proposalId, hash: patch.hash }, options.overrides)
    return ledger.createPushProposal({ scope: SCOPE, runId: patch.runId, plan })
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

  it('refuses a plan bound to a patch that was never applied', () => {
    const run = runningRun()
    const pending = patchProposal(run.runId, run.generation, 'pending')

    expect(createPush({ patch: pending })).toEqual({ ok: false, reason: 'patch-not-applied' })
  })

  it('refuses a plan bound to a failed patch application', () => {
    const run = runningRun()
    const failed = patchProposal(run.runId, run.generation, 'failed')

    expect(createPush({ patch: failed })).toEqual({ ok: false, reason: 'patch-not-applied' })
  })

  it('refuses a plan whose patch hash is not the applied manifest', () => {
    const patch = appliedPatch()

    expect(
      createPush({
        patch,
        overrides: { patch: { proposalId: patch.proposalId, hash: 'f'.repeat(64) } }
      })
    ).toEqual({ ok: false, reason: 'patch-mismatch' })
  })

  it('refuses a plan that pairs a branch or base the patch never had', () => {
    const patch = appliedPatch()

    expect(createPush({ patch, overrides: { branch: 'release' } })).toEqual({
      ok: false,
      reason: 'patch-mismatch'
    })
    expect(createPush({ patch, overrides: { expectedHeadSha: NEXT_BASE } })).toEqual({
      ok: false,
      reason: 'patch-mismatch'
    })
  })

  it('refuses a plan for a run that does not exist', () => {
    const patch = appliedPatch()
    const plan = planInput({ proposalId: patch.proposalId, hash: patch.hash })

    expect(ledger.createPushProposal({ scope: SCOPE, runId: 9999, plan })).toEqual({
      ok: false,
      reason: 'run-missing'
    })
  })

  it('refuses a patch proposal that belongs to another run', () => {
    const patch = appliedPatch()
    const other = runningRun('d-2')
    const plan = planInput({ proposalId: patch.proposalId, hash: patch.hash })

    expect(ledger.createPushProposal({ scope: SCOPE, runId: other.runId, plan })).toEqual({
      ok: false,
      reason: 'patch-mismatch'
    })
  })

  it('refuses an unsafe branch or an unpinned head', () => {
    const built = buildForgePushPlan(
      planInput({ proposalId: 1, hash: 'a'.repeat(64) }, { branch: '../main' })
    )
    expect(built).toEqual({ ok: false, reason: 'branch-invalid' })
    expect(
      buildForgePushPlan(
        planInput({ proposalId: 1, hash: 'a'.repeat(64) }, { expectedHeadSha: 'abc' })
      )
    ).toEqual({ ok: false, reason: 'base-invalid' })
    expect(
      buildForgePushPlan(planInput({ proposalId: 1, hash: 'a'.repeat(64) }, { treeSha: 'abc' }))
    ).toEqual({ ok: false, reason: 'tree-invalid' })
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
    const patch = appliedPatch()
    const build = (message: string) =>
      ledger.createPushProposal({
        scope: SCOPE,
        runId: patch.runId,
        plan: planInput(
          { proposalId: patch.proposalId, hash: patch.hash },
          { commit: { author: IDENTITY, committer: IDENTITY, message } }
        )
      })
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
