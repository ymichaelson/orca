import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { previewForgeProposal } from './forge-inbox-proposal-preview'

/** Preview and reject work while dormant: neither may open or create a ledger. */
export function createForgeOwnerProposalActions(getLedger: () => ForgeInboxLedger | null) {
  return {
    /** Null while dormant: reading must not create a ledger, and there is nothing to preview yet. */
    getProposalPreview(scope: ForgeInstanceScope, proposalId: number) {
      const ledger = getLedger()
      const proposal = ledger?.getProposal(proposalId)
      if (!ledger || !proposal || !ledger.getItem(scope, proposal.itemId)) {
        return null
      }
      return previewForgeProposal(proposal)
    },
    /** Rejection is local state only: no network, no credential, and it never touches the project switch. */
    rejectProposal(
      scope: ForgeInstanceScope,
      proposalId: number
    ): { ok: true } | { ok: false; reason: 'not-found' | 'not-pending' } {
      const ledger = getLedger()
      const proposal = ledger?.getProposal(proposalId)
      if (!ledger || !proposal || !ledger.getItem(scope, proposal.itemId)) {
        return { ok: false as const, reason: 'not-found' as const }
      }
      const result = ledger.rejectProposal(proposalId)
      return result.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            reason: result.reason === 'not-pending' ? result.reason : 'not-found'
          }
    }
  }
}
