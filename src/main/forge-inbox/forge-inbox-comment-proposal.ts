import type { ForgeInstanceScope, ForgeProposal } from '../../shared/forge-inbox-types'
import { approveForgeProposal } from './forge-inbox-proposal-approval'
import {
  buildForgeCommentDraft,
  hashForgeCommentDraft,
  parseForgeCommentDraft,
  type ForgeCommentDraft,
  type ForgeCommentDraftFailure,
  type ForgeCommentTarget
} from './forge-inbox-comment-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeCommentHead = { ok: true; sha: string } | { ok: false; code: string }
export type ForgeCommentHeadReader = (
  target: ForgeCommentTarget,
  signal: AbortSignal
) => Promise<ForgeCommentHead>

export type ForgeCommentProposalFailure =
  | ForgeCommentDraftFailure
  | 'run-missing'
  | 'item-missing'
  | 'item-mismatch'
  | 'run-not-running'
  | 'generation-mismatch'
  | 'policy-generation-mismatch'
  | 'not-found'
  | 'not-pending'
  | 'not-a-comment'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'
  | 'stale'

export type ForgeCommentProposalCreated =
  | { ok: true; proposal: ForgeProposal; draft: ForgeCommentDraft; hash: string }
  | { ok: false; reason: ForgeCommentProposalFailure }

/** Approval fails only on identity, version or head: draft and run checks ran when it was created. */
export type ForgeCommentApprovalRefusal =
  | 'not-found'
  | 'not-pending'
  | 'stale'
  | 'not-a-comment'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'

export type ForgeCommentProposalApproved =
  | { ok: true; proposal: ForgeProposal }
  | { ok: false; reason: ForgeCommentApprovalRefusal }

/**
 * Creates the one comment the owner may approve for this run's item. The draft must name exactly
 * the item the run analysed; a newer draft makes older pending ones stale instead of leaving two
 * live approvals for one target.
 */
export function createForgeCommentProposal(
  deps: { ledger: Pick<ForgeInboxLedger, 'getRun' | 'getItem' | 'createProposal'> },
  input: {
    scope: ForgeInstanceScope
    runId: number
    expectedGeneration: number
    draft: { target: ForgeCommentTarget; headSha: string | null; body: string }
  }
): ForgeCommentProposalCreated {
  const built = buildForgeCommentDraft(input.draft)
  if (!built.ok) {
    return built
  }
  const run = deps.ledger.getRun(input.runId)
  if (!run) {
    return { ok: false, reason: 'run-missing' }
  }
  const item = deps.ledger.getItem(input.scope, run.itemId)
  if (!item) {
    return { ok: false, reason: 'item-missing' }
  }
  const draft = built.draft
  if (
    draft.target.instanceId !== item.instanceId ||
    draft.target.projectId !== item.projectId ||
    draft.target.kind !== item.kind ||
    draft.target.iid !== item.iid
  ) {
    return { ok: false, reason: 'item-mismatch' }
  }
  const created = deps.ledger.createProposal({
    runId: input.runId,
    expectedGeneration: input.expectedGeneration,
    body: draft,
    supersedePending: true
  })
  if (!created.ok) {
    return created
  }
  return { ok: true, proposal: created.proposal, draft, hash: built.hash }
}

/**
 * Consumes an approval exactly once, and only for the draft the client displayed. A merge request
 * head that moved since the draft makes the approval stale; an unreadable head leaves it pending.
 */
export async function approveForgeComment(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'consumeProposal' | 'staleProposal'>
    readHead: ForgeCommentHeadReader
  },
  input: {
    scope: ForgeInstanceScope
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  },
  signal: AbortSignal
): Promise<ForgeCommentProposalApproved> {
  const result = await approveForgeProposal(
    {
      ledger: deps.ledger,
      parseDraft: parseForgeCommentDraft,
      hashDraft: hashForgeCommentDraft,
      checkHead: async (draft) => {
        if (draft.headSha === null) {
          return 'ok'
        }
        const head = await deps.readHead(draft.target, signal)
        if (!head.ok) {
          return 'head-unavailable'
        }
        return head.sha === draft.headSha ? 'ok' : 'head-moved'
      }
    },
    input
  )
  if (result.ok) {
    return result
  }
  return result.reason === 'not-this-kind'
    ? { ok: false, reason: 'not-a-comment' }
    : { ok: false, reason: result.reason }
}
