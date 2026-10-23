import type {
  ForgeItemDetailView,
  ForgeProposalView,
  ForgeRunView
} from '../../shared/forge-inbox-rpc-types'
import type { ForgePage, ForgeProposal, ForgeRun } from '../../shared/forge-inbox-types'
import { GITLAB_RELEVANCE_CATEGORIES } from './forge-inbox-gitlab-relevance'
import type { ForgeItemDetail } from './forge-inbox-queries'

export type { ForgeItemDetailView, ForgeProposalView, ForgeRunView }

// Why allowlists: the ledger stores whatever a caller wrote, so only values our own producers emit may leave the host.
const KNOWN_RUN_REASONS: ReadonlySet<string> = new Set(GITLAB_RELEVANCE_CATEGORIES)
const KNOWN_RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  'worker-error',
  'analysis-failed',
  'output-budget',
  'policy-revoked',
  'owner-stopped',
  'unknown-outcome'
])

/** Run text can come from a backend, so only values our producers emit leave the host. */
export function projectForgeRun(run: ForgeRun): ForgeRunView {
  const { error, reason, ...rest } = run
  return {
    ...rest,
    reason: KNOWN_RUN_REASONS.has(reason) ? reason : null,
    errorCode: error === null ? null : KNOWN_RUN_ERROR_CODES.has(error) ? error : 'unknown'
  }
}

/** Raw proposal bodies hold generated text and tool input; clients get status and versions only. */
export function projectForgeProposal(proposal: ForgeProposal): ForgeProposalView {
  const { body: _body, ...rest } = proposal
  return rest
}

export function projectForgeRunPage(page: ForgePage<ForgeRun>): ForgePage<ForgeRunView> {
  return { rows: page.rows.map(projectForgeRun), nextCursor: page.nextCursor }
}

export function projectForgeItemDetail(detail: ForgeItemDetail): ForgeItemDetailView {
  return {
    item: detail.item,
    revisions: detail.revisions,
    runs: detail.runs.map(projectForgeRun),
    proposals: detail.proposals.map(projectForgeProposal)
  }
}
