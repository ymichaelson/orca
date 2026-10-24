import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgeInboxPatchApplyOutcome } from '../../shared/forge-inbox-rpc-types'
import type { ForgePatchDraft } from './forge-inbox-patch-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { applyForgePatchProposal } from './forge-inbox-patch-broker'
import { approveForgePatch, type ForgePatchHeadReader } from './forge-inbox-patch-proposal'
import type { ForgePatchSource } from './forge-inbox-patch-tree'

export type ForgePatchApplyInput = {
  scope: ForgeInstanceScope
  proposalId: number
  expectedHash: string
  expectedRevision: number
  expectedPolicyGeneration: number
}

export type ForgePatchApplyDeps = {
  ledger: Pick<
    ForgeInboxLedger,
    | 'getProposal'
    | 'getItem'
    | 'consumeProposal'
    | 'staleProposal'
    | 'beginReceipt'
    | 'finishReceipt'
  >
  readHead: ForgePatchHeadReader
  source: (draft: ForgePatchDraft) => ForgePatchSource
  parentDirectory: string
}

/**
 * Approves the exact displayed draft and then materialises it. The approval is consumed first:
 * a build that fails afterwards keeps its receipt, and its directory never leaves this host.
 */
export async function approveAndApplyForgePatch(
  deps: ForgePatchApplyDeps,
  input: ForgePatchApplyInput,
  signal: AbortSignal
): Promise<ForgeInboxPatchApplyOutcome> {
  const approval = await approveForgePatch(deps, input, signal)
  if (!approval.ok) {
    return approval
  }
  const applied = await applyForgePatchProposal(deps, input, signal)
  if (applied.kind === 'applied') {
    return {
      ok: true,
      receiptId: applied.receiptId,
      written: applied.written,
      removed: applied.removed
    }
  }
  return applied.kind === 'failed'
    ? { ok: false, reason: applied.reason, receiptId: applied.receiptId }
    : { ok: false, reason: applied.reason }
}
