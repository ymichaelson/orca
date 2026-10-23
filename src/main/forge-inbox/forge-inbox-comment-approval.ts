import type {
  ForgeCommentApprovalFailure,
  ForgeCommentApprovalOutcome
} from '../../shared/forge-inbox-rpc-types'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgeCommentBroker } from './forge-inbox-comment-broker'
import { approveForgeComment } from './forge-inbox-comment-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

/** Codes the delivery layer emits; anything else collapses so no backend text reaches a client. */
const DELIVERY_FAILURES: Readonly<Record<string, ForgeCommentApprovalFailure>> = {
  cancelled: 'cancelled',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'rate-limited': 'rate-limited',
  'too-large': 'too-large',
  'request-too-large': 'too-large',
  'bad-response': 'bad-response',
  network: 'network',
  'stale-config': 'stale-config',
  'no-credential': 'no-credential'
}

/**
 * One approved comment, end to end: consume the approval only if the displayed draft and head
 * still match, then let the host broker publish it. Every failure here is reported by code; none
 * of them retries a write whose outcome is unknown.
 */
export async function approveAndPublishForgeComment(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'consumeProposal' | 'staleProposal'>
    broker: ForgeCommentBroker
  },
  input: {
    scope: ForgeInstanceScope
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  },
  signal: AbortSignal
): Promise<ForgeCommentApprovalOutcome> {
  const approved = await approveForgeComment(
    { ledger: deps.ledger, readHead: deps.broker.readHead },
    input,
    signal
  )
  if (!approved.ok) {
    return { ok: false, reason: approved.reason }
  }
  const published = await deps.broker.publish(
    { scope: input.scope, proposalId: input.proposalId, expectedHash: input.expectedHash },
    signal
  )
  switch (published.kind) {
    case 'published':
      return { ok: true, receiptId: published.receiptId, noteId: published.noteId }
    case 'unknown':
      return { ok: false, reason: published.reason }
    case 'refused':
      return { ok: false, reason: published.reason }
    case 'failed':
      return { ok: false, reason: deliveryFailure(published.reason) }
  }
}

function deliveryFailure(code: string): ForgeCommentApprovalFailure {
  return DELIVERY_FAILURES[code] ?? 'delivery-failed'
}
