import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type {
  ForgePatchApplyFailureReason,
  ForgePatchApprovalRefusal
} from '../../shared/forge-patch-request'
import {
  hashForgePatchDraft,
  parseForgePatchDraft,
  type ForgePatchDraft
} from './forge-inbox-patch-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { applyForgePatchInIsolation, type ForgePatchSource } from './forge-inbox-patch-tree'

export type ForgePatchApplyRefusal = Extract<
  ForgePatchApprovalRefusal,
  'not-found' | 'not-approved' | 'not-a-patch' | 'draft-mismatch' | 'already-applied'
>

export type ForgePatchApplyResult =
  | { kind: 'applied'; receiptId: number; directory: string; written: string[]; removed: string[] }
  | { kind: 'failed'; receiptId: number; reason: ForgePatchApplyFailureReason }
  | { kind: 'refused'; reason: ForgePatchApplyRefusal }

/**
 * Materialises an approved patch in a throwaway directory and records the attempt in a receipt.
 * Nothing is pushed here: a stale base or a failed read stops before any forge write.
 */
export async function applyForgePatchProposal(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'beginReceipt' | 'finishReceipt'>
    source: (draft: ForgePatchDraft) => ForgePatchSource
    parentDirectory: string
  },
  input: { scope: ForgeInstanceScope; proposalId: number; expectedHash: string },
  signal: AbortSignal
): Promise<ForgePatchApplyResult> {
  const proposal = deps.ledger.getProposal(input.proposalId)
  if (!proposal) {
    return { kind: 'refused', reason: 'not-found' }
  }
  const draft = parseForgePatchDraft(proposal.body)
  if (!draft) {
    return { kind: 'refused', reason: 'not-a-patch' }
  }
  if (hashForgePatchDraft(draft) !== input.expectedHash) {
    return { kind: 'refused', reason: 'draft-mismatch' }
  }
  if (!deps.ledger.getItem(input.scope, proposal.itemId)) {
    return { kind: 'refused', reason: 'not-found' }
  }
  if (proposal.status !== 'consumed') {
    return { kind: 'refused', reason: 'not-approved' }
  }
  const begun = deps.ledger.beginReceipt({ proposalId: proposal.id })
  if (!begun.receipt) {
    return { kind: 'refused', reason: 'not-approved' }
  }
  if (!begun.started) {
    return { kind: 'refused', reason: 'already-applied' }
  }

  const tree = await applyForgePatchInIsolation(
    { source: deps.source(draft), parentDirectory: deps.parentDirectory, signal },
    draft
  )
  if (!tree.ok) {
    deps.ledger.finishReceipt(begun.receipt.id, {
      state: 'failed',
      result: { reason: tree.reason }
    })
    return { kind: 'failed', receiptId: begun.receipt.id, reason: tree.reason }
  }
  deps.ledger.finishReceipt(begun.receipt.id, {
    state: 'applied',
    result: {
      baseSha: draft.baseSha,
      branch: draft.branch,
      written: tree.written,
      removed: tree.removed
    }
  })
  return {
    kind: 'applied',
    receiptId: begun.receipt.id,
    directory: tree.directory,
    written: tree.written,
    removed: tree.removed
  }
}
