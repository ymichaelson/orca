import type { ForgeInstanceScope, ForgeProposal } from '../../shared/forge-inbox-types'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

/** The reviewed base is gone (`head-moved`) or could not be read this time (`head-unavailable`). */
export type ForgeProposalHeadCheck = 'ok' | 'head-unavailable' | 'head-moved'

export type ForgeProposalApprovalFailure =
  | 'not-found'
  | 'not-pending'
  | 'stale'
  | 'not-this-kind'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'

export type ForgeProposalApprovalResult =
  | { ok: true; proposal: ForgeProposal }
  | { ok: false; reason: ForgeProposalApprovalFailure }

/**
 * Consumes an approval exactly once, and only for the draft the owner displayed. The draft kind is
 * supplied by the caller; a body that is not that kind is refused before any scope or hash check.
 */
export async function approveForgeProposal<Draft>(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'consumeProposal' | 'staleProposal'>
    parseDraft: (body: unknown) => Draft | null
    hashDraft: (draft: Draft) => string
    checkHead: (draft: Draft) => Promise<ForgeProposalHeadCheck>
  },
  input: {
    scope: ForgeInstanceScope
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  }
): Promise<ForgeProposalApprovalResult> {
  const proposal = deps.ledger.getProposal(input.proposalId)
  if (!proposal) {
    return { ok: false, reason: 'not-found' }
  }
  if (proposal.status === 'stale') {
    return { ok: false, reason: 'stale' }
  }
  if (proposal.status !== 'pending') {
    return { ok: false, reason: 'not-pending' }
  }
  const draft = deps.parseDraft(proposal.body)
  if (!draft) {
    return { ok: false, reason: 'not-this-kind' }
  }
  // Scope check before anything the caller could learn from: another instance's item is not here.
  if (!deps.ledger.getItem(input.scope, proposal.itemId)) {
    return { ok: false, reason: 'not-found' }
  }
  if (deps.hashDraft(draft) !== input.expectedHash) {
    return { ok: false, reason: 'draft-mismatch' }
  }
  if (
    proposal.revision !== input.expectedRevision ||
    proposal.policyGeneration !== input.expectedPolicyGeneration
  ) {
    return { ok: false, reason: 'stale' }
  }
  const head = await deps.checkHead(draft)
  if (head === 'head-unavailable') {
    return { ok: false, reason: 'head-unavailable' }
  }
  if (head === 'head-moved') {
    deps.ledger.staleProposal(input.proposalId, {
      revision: proposal.revision,
      policyGeneration: proposal.policyGeneration
    })
    return { ok: false, reason: 'head-moved' }
  }
  const consumed = deps.ledger.consumeProposal(input.proposalId, {
    revision: proposal.revision,
    policyGeneration: proposal.policyGeneration
  })
  return consumed.ok ? { ok: true, proposal: consumed.proposal } : consumed
}
