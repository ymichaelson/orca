import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  beginForgeReceipt,
  consumeForgeProposal,
  createForgeProposal,
  finishForgeReceipt,
  readForgeProposal,
  readForgeReceiptForProposal,
  rejectForgeProposal,
  staleForgeProposal
} from './forge-inbox-proposals'
import { createForgePushProposal } from './forge-inbox-push-proposal'

/** Proposal and receipt access shared by every ledger capability; approvals and builds use it. */
export class ForgeProposalLedger {
  protected constructor(protected readonly ctx: ForgeLedgerContext) {}

  createProposal(input: Parameters<typeof createForgeProposal>[1]) {
    return createForgeProposal(this.ctx, input)
  }

  createPushProposal(input: Parameters<typeof createForgePushProposal>[1]) {
    return createForgePushProposal(this.ctx, input)
  }

  getProposalReceipt(proposalId: number) {
    return readForgeReceiptForProposal(this.ctx, proposalId)
  }

  getProposal(id: number) {
    return readForgeProposal(this.ctx, id)
  }

  consumeProposal(id: number, expected: Parameters<typeof consumeForgeProposal>[2]) {
    return consumeForgeProposal(this.ctx, id, expected)
  }

  rejectProposal(id: number) {
    return rejectForgeProposal(this.ctx, id)
  }

  staleProposal(id: number, expected: Parameters<typeof staleForgeProposal>[2]) {
    return staleForgeProposal(this.ctx, id, expected)
  }

  beginReceipt(input: Parameters<typeof beginForgeReceipt>[1]) {
    return beginForgeReceipt(this.ctx, input)
  }

  finishReceipt(id: number, outcome: Parameters<typeof finishForgeReceipt>[2]) {
    return finishForgeReceipt(this.ctx, id, outcome)
  }
}
