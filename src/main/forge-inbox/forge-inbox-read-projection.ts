import type {
  ForgeItemDetailView,
  ForgeProposalView,
  ForgeRunView
} from '../../shared/forge-inbox-rpc-types'
import {
  FORGE_DECISION_ERROR_CODES,
  FORGE_RUN_ERROR_CODES
} from '../../shared/forge-inbox-error-codes'
import type { ForgeDispatchConfirmationView } from '../../shared/forge-inbox-dispatch-confirmation'
import type { ForgeRunCancellationView } from '../../shared/forge-inbox-run-cancellation'
import type { ForgeRunDispatchFacts } from './forge-inbox-run-dispatch-view'
import type { ForgeItemTimelineEntry } from '../../shared/forge-inbox-item-timeline'
import type { ForgePage, ForgeProposal, ForgeRun } from '../../shared/forge-inbox-types'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-action-dispatch'
import { GITLAB_RELEVANCE_CATEGORIES } from './forge-inbox-gitlab-relevance'
import type { ForgeItemDetail } from './forge-inbox-queries'

export type { ForgeItemDetailView, ForgeProposalView, ForgeRunView }

// Why allowlists: the ledger stores whatever a caller wrote, so only values our own producers emit may leave the host.
const KNOWN_RUN_REASONS: ReadonlySet<string> = new Set([
  ...GITLAB_RELEVANCE_CATEGORIES,
  PROJECT_EVENT_DISPATCH_RUN_REASON
])
const KNOWN_RUN_ERROR_CODES: ReadonlySet<string> = new Set(FORGE_RUN_ERROR_CODES)
const KNOWN_DECISION_ERROR_CODES: ReadonlySet<string> = new Set(FORGE_DECISION_ERROR_CODES)

function projectedReason(reason: string): string | null {
  return KNOWN_RUN_REASONS.has(reason) ? reason : null
}

/** Run text can come from a backend, so only values our producers emit leave the host. */
export function projectForgeRun(
  run: ForgeRun,
  dispatchConfirmation?: ForgeDispatchConfirmationView,
  cancellation?: ForgeRunCancellationView,
  dispatch?: ForgeRunDispatchFacts
): ForgeRunView {
  const { error, reason, ...rest } = run
  return {
    ...rest,
    reason: projectedReason(reason),
    errorCode: error === null ? null : KNOWN_RUN_ERROR_CODES.has(error) ? error : 'unknown',
    ...(dispatchConfirmation === undefined ? {} : { dispatchConfirmation }),
    ...(cancellation === undefined ? {} : { cancellation }),
    ...(dispatch?.snapshot === undefined ? {} : { dispatchSnapshot: dispatch.snapshot }),
    ...(dispatch?.terminalExit === undefined ? {} : { terminalExit: dispatch.terminalExit })
  }
}

/** Raw proposal bodies hold generated text and tool input; clients get status and versions only. */
export function projectForgeProposal(proposal: ForgeProposal): ForgeProposalView {
  const { body: _body, ...rest } = proposal
  return rest
}

export function projectForgeRunPage(
  page: ForgePage<ForgeRun>,
  confirmations: ReadonlyMap<number, ForgeDispatchConfirmationView> = new Map(),
  cancellations: ReadonlyMap<number, ForgeRunCancellationView> = new Map(),
  dispatch: ReadonlyMap<number, ForgeRunDispatchFacts> = new Map()
): ForgePage<ForgeRunView> {
  return {
    rows: page.rows.map((run) =>
      projectForgeRun(
        run,
        confirmations.get(run.id),
        cancellations.get(run.id),
        dispatch.get(run.id)
      )
    ),
    nextCursor: page.nextCursor
  }
}

function projectTimelineEntry(entry: ForgeItemTimelineEntry): ForgeItemTimelineEntry {
  if (entry.kind === 'run') {
    return { ...entry, reason: entry.reason === null ? null : projectedReason(entry.reason) }
  }
  if (entry.kind === 'decision' && entry.errorCode !== null) {
    return {
      ...entry,
      errorCode: KNOWN_DECISION_ERROR_CODES.has(entry.errorCode) ? entry.errorCode : 'unknown'
    }
  }
  return entry
}

export function projectForgeItemDetail(detail: ForgeItemDetail): ForgeItemDetailView {
  return {
    item: detail.item,
    revisions: detail.revisions,
    runs: detail.runs.map((run) =>
      projectForgeRun(
        run,
        detail.dispatchConfirmations?.get(run.id),
        detail.cancellations?.get(run.id),
        detail.dispatchFacts?.get(run.id)
      )
    ),
    proposals: detail.proposals.map(projectForgeProposal),
    handling: {
      ...detail.handling,
      errorCode:
        detail.handling.errorCode === null
          ? null
          : KNOWN_DECISION_ERROR_CODES.has(detail.handling.errorCode)
            ? detail.handling.errorCode
            : 'unknown'
    },
    timeline: detail.timeline.map(projectTimelineEntry),
    repoId: detail.repoId
  }
}
