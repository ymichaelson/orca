import type {
  ForgeItemHandlingState,
  ForgeItemHandlingView
} from '../../shared/forge-inbox-item-handling'
import { FORGE_RUN_STATES, type ForgeRunState } from '../../shared/forge-inbox-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber } from './forge-inbox-rows'
import { forgeDeliveryErrorSource } from './forge-inbox-error-source'
import type { DispatchRecommendationAction } from './forge-inbox-dispatch-report'
import { readStoredDispatchReport } from './forge-inbox-dispatch-report'
import type { SqliteRow } from '../sqlite/sqlite-statement'

export type ForgeItemHandlingInput = {
  openQuestions: number
  pendingProposals: number
  unknownReceipts: number
  unresolvedDispatches: number
  runState: string | null
  /** The latest run was asked to stop; it is still running until its own turn proves how it ended. */
  runStopRequested?: boolean
  action: string | null
  actionError: string | null
  deliveryState: string | null
  decisionState?: string | null
  parkedReason: string | null
  deliveryError: string | null
}

function handling(state: ForgeItemHandlingState): ForgeItemHandlingView {
  return { state, errorCode: null }
}

/**
 * Precedence is the user's: a question or approval outranks everything, an unknown remote result
 * or a dispatched agent's unchecked GitLab effects are never rounded to done, and a settled action
 * without a decision is only a record.
 */
export function forgeItemHandling(input: ForgeItemHandlingInput): ForgeItemHandlingView {
  const awaitingUser =
    input.openQuestions > 0 ||
    input.pendingProposals > 0 ||
    input.deliveryState === 'needs-auth' ||
    (input.deliveryState === 'parked' && input.parkedReason === 'awaiting-user') ||
    input.runState === 'awaiting-approval'
  if (awaitingUser) {
    return handling('needs-user')
  }
  // A duplicate dispatch was refused because this change is already claimed, not because anything failed.
  const duplicateDispatch =
    input.runState !== null &&
    (input.actionError === 'already-dispatched' || input.deliveryError === 'already-dispatched')
  if (input.runState === 'failed' || (input.deliveryState === 'failed' && !duplicateDispatch)) {
    const errorSource = forgeDeliveryErrorSource({
      decisionState: input.decisionState ?? null,
      action: input.action,
      deliveryError: input.deliveryError,
      actionError: input.actionError
    })
    return {
      state: 'failed',
      errorCode: input.deliveryError ?? input.actionError,
      ...(errorSource === 'unknown' ? {} : { errorSource })
    }
  }
  if (input.unknownReceipts > 0 || input.runState === 'unverifiable') {
    return handling('unconfirmed')
  }
  const inFlight =
    input.deliveryState === 'pending' || input.runState === 'queued' || input.runState === 'running'
  if (inFlight) {
    return input.runState === 'running' && input.runStopRequested === true
      ? { state: 'processing', errorCode: null, stopping: true }
      : handling('processing')
  }
  if (input.unresolvedDispatches > 0) {
    return handling('unconfirmed')
  }
  if (input.deliveryState === 'parked') {
    return handling('waiting')
  }
  if (input.action === null || input.action === 'record_only') {
    return handling('recorded')
  }
  return handling('done')
}

/** Per-item facts `forgeItemHandling` needs, usable in any query that has the `items i` alias. */
export function handlingSelectSql(): string {
  return `(SELECT COUNT(*) FROM project_event_questions q
    WHERE q.item_id = i.id AND q.status = 'open') AS open_questions,
  (SELECT COUNT(*) FROM proposals p
    WHERE p.item_id = i.id AND p.status = 'pending') AS pending_proposals,
  (SELECT COUNT(*) FROM receipts r JOIN proposals p ON p.id = r.proposal_id
    WHERE p.item_id = i.id AND r.state = 'unknown') AS unknown_receipts,
  (SELECT COUNT(*) FROM run_dispatch_confirmations c
    WHERE c.host_id = i.host_id AND c.state NOT IN ('confirmed', 'no-claim')
      AND c.run_id = (SELECT r.id FROM runs r WHERE r.item_id = i.id ORDER BY r.id DESC LIMIT 1)
  ) AS unresolved_dispatches,
  (SELECT r.state FROM runs r WHERE r.item_id = i.id ORDER BY r.id DESC LIMIT 1) AS run_state,
  (SELECT r.cancel_requested_at IS NOT NULL FROM runs r WHERE r.item_id = i.id
    ORDER BY r.id DESC LIMIT 1) AS run_stop_requested,
  (SELECT c.report_json FROM run_dispatch_confirmations c
    WHERE c.host_id = i.host_id
      AND c.run_id = (SELECT r.id FROM runs r WHERE r.item_id = i.id ORDER BY r.id DESC LIMIT 1)
  ) AS latest_dispatch_report,
  d.action, d.last_error_code AS action_error,
  w.state AS delivery_state, w.decision_state, w.parked_reason, w.last_error_code AS delivery_error`
}

/** The joins `handlingSelectSql` reads through; a list query adds them next to its own. */
export function handlingJoinsSql(): string {
  return `LEFT JOIN webhook_deliveries w ON w.host_id = i.host_id AND w.id = (
  SELECT delivery_id FROM project_event_decisions
  WHERE item_id = i.id AND host_id = i.host_id
  ORDER BY id DESC LIMIT 1)
LEFT JOIN project_event_decisions d ON d.id = (
  SELECT id FROM project_event_decisions
  WHERE delivery_id = w.id AND host_id = i.host_id AND superseded = 0
  ORDER BY id DESC LIMIT 1)`
}

const HANDLING_SQL = `SELECT ${handlingSelectSql()}
FROM items i
${handlingJoinsSql()}
WHERE i.id = ? AND i.host_id = ?`

function optionalText(row: SqliteRow, column: string): string | null {
  return typeof row[column] === 'string' ? row[column] : null
}

function count(row: SqliteRow, column: string): number {
  return row[column] === undefined ? 0 : rowNumber(row, column)
}

export function forgeItemHandlingInputOf(row: SqliteRow): ForgeItemHandlingInput {
  return {
    openQuestions: count(row, 'open_questions'),
    pendingProposals: count(row, 'pending_proposals'),
    unknownReceipts: count(row, 'unknown_receipts'),
    unresolvedDispatches: count(row, 'unresolved_dispatches'),
    runState: optionalText(row, 'run_state'),
    runStopRequested: Number(row.run_stop_requested ?? 0) === 1,
    action: optionalText(row, 'action'),
    actionError: optionalText(row, 'action_error'),
    deliveryState: optionalText(row, 'delivery_state'),
    decisionState: optionalText(row, 'decision_state'),
    parkedReason: optionalText(row, 'parked_reason'),
    deliveryError: optionalText(row, 'delivery_error')
  }
}

/** What a list row labels itself with; the run and its report are the latest one, whatever its state. */
export function forgeListItemStatusOf(row: SqliteRow): {
  handling: ForgeItemHandlingView
  latestRunState: ForgeRunState | null
  recommendationAction: DispatchRecommendationAction | null
} {
  const runState = optionalText(row, 'run_state')
  const report = readStoredDispatchReport(optionalText(row, 'latest_dispatch_report'))
  return {
    handling: forgeItemHandling(forgeItemHandlingInputOf(row)),
    latestRunState: FORGE_RUN_STATES.find((state) => state === runState) ?? null,
    recommendationAction:
      report.status === 'claims' ? (report.recommendation?.action ?? null) : null
  }
}

/** Reads one item's handling; a missing item is the caller's bug, so it reads as recorded. */
export function readForgeItemHandling(
  ctx: ForgeLedgerContext,
  itemId: number
): ForgeItemHandlingView {
  const row = ctx.db.prepare(HANDLING_SQL).get(itemId, ctx.hostId)
  return row ? forgeItemHandling(forgeItemHandlingInputOf(row)) : handling('recorded')
}
