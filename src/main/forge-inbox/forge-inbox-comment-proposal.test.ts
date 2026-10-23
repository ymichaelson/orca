import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeCommentDraft, ForgeCommentTarget } from './forge-inbox-comment-draft'
import {
  buildForgeCommentDraft,
  hashForgeCommentDraft,
  parseForgeCommentDraft
} from './forge-inbox-comment-draft'
import {
  approveForgeComment,
  createForgeCommentProposal,
  type ForgeCommentHeadReader
} from './forge-inbox-comment-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)

function project(overrides: Record<string, unknown> = {}) {
  return { projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true, ...overrides }
}

function target(overrides: Partial<ForgeCommentTarget> = {}): ForgeCommentTarget {
  return {
    instanceId: INSTANCE_ID,
    projectId: '42',
    kind: 'merge_request',
    iid: 7,
    ...overrides
  }
}

function draft(
  overrides: { headSha?: string | null; body?: string; target?: ForgeCommentTarget } = {}
) {
  const built = buildForgeCommentDraft({
    target: overrides.target ?? target(),
    headSha: overrides.headSha === undefined ? HEAD : overrides.headSha,
    body: overrides.body ?? 'Looks good to me.'
  })
  if (!built.ok) {
    throw new Error(`draft rejected: ${built.reason}`)
  }
  return built
}

describe('forge inbox comment proposal', () => {
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

  function observe(sourceOrder = 1): number | null {
    const input: ForgeObservationInput = {
      hostId: ledger.hostId,
      ...SCOPE,
      projectId: '42',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: `d-${sourceOrder}`,
      eventKind: 'merge_request.review_requested',
      payload: {},
      versionToken: `sha256:v${sourceOrder}`,
      ...(sourceOrder === 1 ? { queueRun: { reason: 'review-request' } } : {})
    }
    const result = ledger.ingestObservation(input, ledger.getConfig().configRevision, 0)
    if (!result.ok || result.duplicate) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result.runId
  }

  function runningRun(): { runId: number; generation: number } {
    const runId = observe()
    if (runId === null) {
      throw new Error('observation did not queue a run')
    }
    ledger.transitionRun(runId, { to: 'running' })
    const run = ledger.getRun(runId)
    if (!run) {
      throw new Error('run vanished')
    }
    return { runId, generation: run.generation }
  }

  function createComment() {
    const run = runningRun()
    const built = draft()
    return {
      run,
      built,
      result: createForgeCommentProposal(
        { ledger },
        {
          scope: SCOPE,
          runId: run.runId,
          expectedGeneration: run.generation,
          draft: {
            target: built.draft.target,
            headSha: built.draft.headSha,
            body: built.draft.body
          }
        }
      )
    }
  }

  function headReader(read: ForgeCommentHeadReader = async () => ({ ok: true, sha: HEAD })) {
    return vi.fn(read)
  }

  function approve(input: {
    proposalId: number
    hash?: string
    revision?: number
    policyGeneration?: number
    readHead?: ReturnType<typeof headReader>
    scope?: { instanceId: string }
  }) {
    const proposal = ledger.getProposal(input.proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }
    return approveForgeComment(
      { ledger, readHead: input.readHead ?? headReader() },
      {
        scope: input.scope ?? SCOPE,
        proposalId: input.proposalId,
        expectedHash: input.hash ?? buildHash(proposal.body),
        expectedRevision: input.revision ?? proposal.revision,
        expectedPolicyGeneration: input.policyGeneration ?? proposal.policyGeneration
      },
      new AbortController().signal
    )
  }

  function buildHash(body: unknown): string {
    const parsed = parseForgeCommentDraft(body)
    if (!parsed) {
      throw new Error('stored proposal is not a comment draft')
    }
    return hashForgeCommentDraft(parsed)
  }

  it('stores the exact draft, its hash and the reviewed head', () => {
    const { built, result } = createComment()
    if (!result.ok) {
      throw new Error(`unexpected refusal ${result.reason}`)
    }

    expect(result.proposal.status).toBe('pending')
    expect(result.proposal.body).toEqual(built.draft)
    expect(result.hash).toBe(built.hash)
    expect(ledger.getProposal(result.proposal.id)?.body).toEqual(built.draft)
  })

  it('refuses a draft aimed at another project than the run analysed', () => {
    const run = runningRun()
    const other = draft({ target: target({ projectId: '43' }) })
    const result = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        draft: { target: other.draft.target, headSha: other.draft.headSha, body: other.draft.body }
      }
    )

    expect(result).toEqual({ ok: false, reason: 'item-mismatch' })
    const itemId = ledger.getRun(run.runId)?.itemId
    if (itemId === undefined) {
      throw new Error('run vanished')
    }
    expect(ledger.getItemDetail(SCOPE, itemId, 'client')?.proposals ?? []).toHaveLength(0)
  })

  it('supersedes the pending draft when a newer one is proposed for the same item', () => {
    const run = runningRun()
    const first = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        ...draftInput(draft({ body: 'First version.' }))
      }
    )
    const second = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        ...draftInput(draft({ body: 'Second version.' }))
      }
    )
    if (!first.ok || !second.ok) {
      throw new Error('unexpected refusal')
    }

    expect(ledger.getProposal(first.proposal.id)?.status).toBe('stale')
    expect(ledger.getProposal(second.proposal.id)?.status).toBe('pending')
  })

  it('refuses a hash the client did not actually see, before reading the forge head', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader()

    await expect(
      approve({ proposalId: result.proposal.id, hash: 'f'.repeat(64), readHead })
    ).resolves.toEqual({
      ok: false,
      reason: 'draft-mismatch'
    })
    expect(readHead).not.toHaveBeenCalled()
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')
  })

  it('marks the proposal stale when the merge request head moved since the draft', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const readHead = headReader(async () => ({ ok: true, sha: NEXT_HEAD }))

    await expect(approve({ proposalId: result.proposal.id, readHead })).resolves.toEqual({
      ok: false,
      reason: 'head-moved'
    })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('stale')
  })

  it('keeps the proposal pending when the head cannot be read', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const failing = headReader(async () => ({ ok: false, code: 'network' }))

    await expect(approve({ proposalId: result.proposal.id, readHead: failing })).resolves.toEqual({
      ok: false,
      reason: 'head-unavailable'
    })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')

    await expect(approve({ proposalId: result.proposal.id })).resolves.toMatchObject({ ok: true })
  })

  it('consumes the approval exactly once', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(approve({ proposalId: result.proposal.id })).resolves.toMatchObject({
      ok: true,
      proposal: { status: 'consumed' }
    })
    await expect(approve({ proposalId: result.proposal.id })).resolves.toEqual({
      ok: false,
      reason: 'not-pending'
    })
  })

  it('refuses an approval for an item version that has already moved', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    observe(2)

    await expect(approve({ proposalId: result.proposal.id })).resolves.toEqual({
      ok: false,
      reason: 'stale'
    })
    // Ingest already retires proposals pinned to an older revision of the item.
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('stale')
  })

  it('refuses a proposal whose body is not a comment draft', async () => {
    const run = runningRun()
    const created = ledger.createProposal({
      runId: run.runId,
      expectedGeneration: run.generation,
      body: { kind: 'patch', files: [] }
    })
    if (!created.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(
      approveForgeComment(
        { ledger, readHead: headReader() },
        {
          scope: SCOPE,
          proposalId: created.proposal.id,
          expectedHash: 'f'.repeat(64),
          expectedRevision: created.proposal.revision,
          expectedPolicyGeneration: created.proposal.policyGeneration
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ ok: false, reason: 'not-a-comment' })
  })

  it('refuses an approval from another instance scope', async () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }

    await expect(
      approve({ proposalId: result.proposal.id, scope: { instanceId: 'gitlab-other' } })
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('pending')
  })

  it('rejects without changing the project switch or its policy generation', () => {
    const { result } = createComment()
    if (!result.ok) {
      throw new Error('unexpected refusal')
    }
    const before = ledger.getConfig()

    expect(ledger.rejectProposal(result.proposal.id).ok).toBe(true)
    expect(ledger.getProposal(result.proposal.id)?.status).toBe('rejected')
    const after = ledger.getConfig()
    expect(after.configRevision).toBe(before.configRevision)
    expect(after.config.instances[0]?.projects[0]).toMatchObject({ enabled: true })
  })
})

function draftInput(built: { draft: ForgeCommentDraft }): {
  draft: { target: ForgeCommentTarget; headSha: string | null; body: string }
} {
  return {
    draft: { target: built.draft.target, headSha: built.draft.headSha, body: built.draft.body }
  }
}
