import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildForgeCommentDraft,
  forgeCommentMarker,
  type ForgeCommentTarget
} from './forge-inbox-comment-draft'
import { approveForgeComment, createForgeCommentProposal } from './forge-inbox-comment-proposal'
import {
  publishForgeComment,
  type ForgeCommentMarkerLookup,
  type ForgeCommentNoteFinder,
  type ForgeCommentPost,
  type ForgeCommentPoster
} from './forge-inbox-comment-publish'
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
const SIGNAL = new AbortController().signal

function project(overrides: Record<string, unknown> = {}) {
  return { projectId: '42', repoId: 'repo-1', workspaceId: 'ws-1', enabled: true, ...overrides }
}

function target(overrides: Partial<ForgeCommentTarget> = {}): ForgeCommentTarget {
  return { instanceId: INSTANCE_ID, projectId: '42', kind: 'merge_request', iid: 7, ...overrides }
}

describe('forge inbox comment publish', () => {
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

  async function approvedComment(): Promise<{ proposalId: number; hash: string }> {
    const run = runningRun()
    const built = buildForgeCommentDraft({
      target: target(),
      headSha: HEAD,
      body: 'Looks good to me.'
    })
    if (!built.ok) {
      throw new Error(`draft rejected: ${built.reason}`)
    }
    const created = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        draft: { target: built.draft.target, headSha: built.draft.headSha, body: built.draft.body }
      }
    )
    if (!created.ok) {
      throw new Error(`proposal refused: ${created.reason}`)
    }
    const approved = await approveForgeComment(
      { ledger, readHead: async () => ({ ok: true, sha: HEAD }) },
      {
        scope: SCOPE,
        proposalId: created.proposal.id,
        expectedHash: built.hash,
        expectedRevision: created.proposal.revision,
        expectedPolicyGeneration: created.proposal.policyGeneration
      },
      SIGNAL
    )
    if (!approved.ok) {
      throw new Error(`approval refused: ${approved.reason}`)
    }
    return { proposalId: created.proposal.id, hash: built.hash }
  }

  function poster(post: ForgeCommentPost = { ok: true, noteId: 11 }) {
    return vi.fn<ForgeCommentPoster>(async () => post)
  }

  function finder(lookup: ForgeCommentMarkerLookup = { ok: true, noteIds: [], complete: true }) {
    return vi.fn<ForgeCommentNoteFinder>(async () => lookup)
  }

  function publish(
    input: { proposalId: number; hash: string; scope?: { instanceId: string } },
    deps: { post?: ReturnType<typeof poster>; findNotes?: ReturnType<typeof finder> } = {}
  ) {
    return publishForgeComment(
      {
        ledger,
        post: deps.post ?? poster(),
        findNotes: deps.findNotes ?? finder()
      },
      {
        scope: input.scope ?? SCOPE,
        proposalId: input.proposalId,
        expectedHash: input.hash
      },
      SIGNAL
    )
  }

  it('publishes the approved text once, with the marker that reconciliation searches for', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: true, noteId: 11 })
    const marker = forgeCommentMarker(proposalId, hash)

    await expect(publish({ proposalId, hash }, { post })).resolves.toMatchObject({
      kind: 'published',
      noteId: 11
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[0].body).toBe(`Looks good to me.\n\n${marker}`)
  })

  it('never posts twice for one approval', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: true, noteId: 11 })

    await publish({ proposalId, hash }, { post })
    await expect(publish({ proposalId, hash }, { post })).resolves.toMatchObject({
      kind: 'published',
      noteId: 11
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reconciles an ambiguous delivery by marker instead of posting again', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: false, code: 'network', mayHaveLanded: true })
    const findNotes = finder({ ok: true, noteIds: [42], complete: true })

    await expect(publish({ proposalId, hash }, { post, findNotes })).resolves.toMatchObject({
      kind: 'published',
      noteId: 42
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(findNotes).toHaveBeenCalledTimes(1)
  })

  it('reports unknown when an ambiguous delivery left no marker on the item', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: false, code: 'network', mayHaveLanded: true })
    const findNotes = finder({ ok: true, noteIds: [], complete: true })

    await expect(publish({ proposalId, hash }, { post, findNotes })).resolves.toEqual({
      kind: 'unknown',
      receiptId: expect.any(Number),
      reason: 'marker-not-found'
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reports unknown when the item notes cannot be read at all', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: false, code: 'network', mayHaveLanded: true })
    const findNotes = finder({ ok: false, code: 'unauthorized' })

    await expect(publish({ proposalId, hash }, { post, findNotes })).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'marker-unavailable'
    })
  })

  it('records a definite rejection as failed without searching for a marker', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster({ ok: false, code: 'forbidden', mayHaveLanded: false })
    const findNotes = finder()

    await expect(publish({ proposalId, hash }, { post, findNotes })).resolves.toMatchObject({
      kind: 'failed',
      reason: 'forbidden'
    })
    expect(findNotes).not.toHaveBeenCalled()
  })

  it('refuses a proposal that was never approved and posts nothing', async () => {
    const run = runningRun()
    const built = buildForgeCommentDraft({ target: target(), headSha: HEAD, body: 'Draft.' })
    if (!built.ok) {
      throw new Error('draft rejected')
    }
    const created = createForgeCommentProposal(
      { ledger },
      {
        scope: SCOPE,
        runId: run.runId,
        expectedGeneration: run.generation,
        draft: { target: built.draft.target, headSha: built.draft.headSha, body: built.draft.body }
      }
    )
    if (!created.ok) {
      throw new Error('proposal refused')
    }
    const post = poster()

    await expect(
      publish({ proposalId: created.proposal.id, hash: built.hash }, { post })
    ).resolves.toEqual({ kind: 'refused', reason: 'not-approved' })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses a consumed proposal whose body is not a comment', async () => {
    const run = runningRun()
    const created = ledger.createProposal({
      runId: run.runId,
      expectedGeneration: run.generation,
      body: { kind: 'patch', files: [] }
    })
    if (!created.ok) {
      throw new Error('proposal refused')
    }
    ledger.consumeProposal(created.proposal.id, {
      revision: created.proposal.revision,
      policyGeneration: created.proposal.policyGeneration
    })
    const post = poster()

    await expect(
      publish({ proposalId: created.proposal.id, hash: 'f'.repeat(64) }, { post })
    ).resolves.toEqual({ kind: 'refused', reason: 'not-a-comment' })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses text other than the approved draft', async () => {
    const { proposalId } = await approvedComment()
    const post = poster()

    await expect(publish({ proposalId, hash: 'f'.repeat(64) }, { post })).resolves.toEqual({
      kind: 'refused',
      reason: 'draft-mismatch'
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses an approval from another instance scope', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster()

    await expect(
      publish({ proposalId, hash, scope: { instanceId: 'gitlab-other' } }, { post })
    ).resolves.toEqual({ kind: 'refused', reason: 'not-found' })
    expect(post).not.toHaveBeenCalled()
  })

  it('does not post once the caller has already aborted', async () => {
    const { proposalId, hash } = await approvedComment()
    const post = poster()
    const stop = new AbortController()
    stop.abort()

    await expect(
      publishForgeComment(
        { ledger, post, findNotes: finder() },
        { scope: SCOPE, proposalId, expectedHash: hash },
        stop.signal
      )
    ).resolves.toMatchObject({ kind: 'failed', reason: 'cancelled' })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses to publish once the item moved past the approved revision', async () => {
    const { proposalId, hash } = await approvedComment()
    observe(2)
    const post = poster()

    await expect(publish({ proposalId, hash }, { post })).resolves.toEqual({
      kind: 'refused',
      reason: 'not-authorised'
    })
    expect(post).not.toHaveBeenCalled()
  })
})
