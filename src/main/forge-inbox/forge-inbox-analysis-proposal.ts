import type { ForgeRun } from '../../shared/forge-inbox-types'
import { createForgeCommentProposal } from './forge-inbox-comment-proposal'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeAnalysisProposalInput = {
  run: ForgeRun
  /** The head the analysis saw; null only for an issue, which has none. */
  headSha: string | null
  body: string
}

/**
 * Binds an analysed draft to this run's revision as a pending comment approval. The draft was
 * written from data, so nothing here can publish it: the owner still approves the exact text.
 */
export function createForgeAnalysisProposal(
  ledger: Pick<ForgeInboxLedger, 'getItem' | 'getRun' | 'createProposal' | 'runPolicyIsCurrent'>
): (input: ForgeAnalysisProposalInput) => void {
  return ({ run, headSha, body }) => {
    if (body.trim() === '') {
      return
    }
    const item = ledger.getItem({}, run.itemId)
    if (!item || (item.kind !== 'merge_request' && item.kind !== 'issue')) {
      return
    }
    if (item.kind === 'merge_request' && headSha === null) {
      return
    }
    // A bump during the turn revokes the run; its draft must not bind to the newer policy.
    if (!ledger.runPolicyIsCurrent(run.id)) {
      return
    }
    createForgeCommentProposal(
      { ledger },
      {
        scope: { instanceId: item.instanceId },
        runId: run.id,
        expectedGeneration: run.generation,
        draft: {
          target: {
            instanceId: item.instanceId,
            projectId: item.projectId,
            kind: item.kind,
            iid: item.iid
          },
          headSha,
          body
        }
      }
    )
  }
}
