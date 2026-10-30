import { randomUUID } from 'node:crypto'
import {
  FORGE_RUN_CANCEL_DELIVERIES,
  type ForgeRunCancelDelivery,
  type ForgeRunCancellationView
} from '../../shared/forge-inbox-run-cancellation'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'
import { OPEN_TERMINAL_RUN_SQL } from './forge-inbox-project-event-run-terminal-state'
import { rowNumber, rowText } from './forge-inbox-rows'

export type StoredRunCancelDelivery = Exclude<ForgeRunCancelDelivery, 'pending'>

export type RunCancelRequest = {
  runId: number
  itemId: number
  sessionId: string
  clientMessageId: string
  operationId: string
  delivery: StoredRunCancelDelivery | null
  /** The runtime fence the delivery was issued against; a different fence is a different runtime. */
  fence: number | null
}

/** A run is still the agent's to finish while it runs, or while an interrupted verdict awaits proof. */
export const OPEN_DISPATCH_RUN_SQL = `(r.state = 'running' OR (r.state = 'unverifiable' AND r.error = 'unknown-outcome') OR ${OPEN_TERMINAL_RUN_SQL})`

/** Fresh id for a request the host has not yet recorded; its timestamp shape is the host's own rule. */
export function mintRunCancelOperationId(): string {
  return createStructuredAgentSessionOperationId(randomUUID)
}

function storedDelivery(value: unknown): StoredRunCancelDelivery | null {
  return value === 'accepted' || value === 'refused' || value === 'unreachable' ? value : null
}

/**
 * Requests that name an exact dispatched turn, so a stop can never reach another one. Without
 * `replay` only requests nobody has delivered yet are returned.
 */
export function listOpenRunCancelRequests(
  ctx: ForgeLedgerContext,
  options: { replay: boolean }
): RunCancelRequest[] {
  return ctx.db
    .prepare(
      `SELECT r.id, r.item_id, r.session_id, r.dispatch_client_message_id, r.cancel_operation_id,
         r.cancel_delivery, r.cancel_fence
       FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.host_id = ? AND r.reason = ? AND r.cancel_requested_at IS NOT NULL
         AND ${OPEN_DISPATCH_RUN_SQL}
         AND r.cancel_operation_id IS NOT NULL AND r.session_id IS NOT NULL
         AND r.dispatch_client_message_id IS NOT NULL
         AND (? = 1 OR r.cancel_delivery IS NULL)
       ORDER BY r.id`
    )
    .all(ctx.hostId, PROJECT_EVENT_DISPATCH_RUN_REASON, options.replay ? 1 : 0)
    .map((row) => ({
      runId: rowNumber(row, 'id'),
      itemId: rowNumber(row, 'item_id'),
      sessionId: rowText(row, 'session_id'),
      clientMessageId: rowText(row, 'dispatch_client_message_id'),
      operationId: rowText(row, 'cancel_operation_id'),
      delivery: storedDelivery(row.cancel_delivery),
      fence: row.cancel_fence === null ? null : rowNumber(row, 'cancel_fence')
    }))
}

/** Guarded by the request's own id, so a late answer never overwrites a newer request's record. */
export function recordRunCancelDelivery(
  ctx: ForgeLedgerContext,
  request: Pick<RunCancelRequest, 'runId' | 'itemId' | 'operationId'>,
  delivery: StoredRunCancelDelivery,
  fence: number | null
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const updated = ctx.db
      .prepare(
        `UPDATE runs SET cancel_delivery = ?, cancel_fence = ?, updated_at = ?
         WHERE id = ? AND cancel_operation_id = ? AND cancel_requested_at IS NOT NULL
           AND (state = 'running' OR (state = 'unverifiable' AND error = 'unknown-outcome')
             OR (state = 'unverifiable' AND error = 'terminal-handoff' AND terminal_handle IS NOT NULL))`
      )
      .run(delivery, fence, ctx.now(), request.runId, request.operationId)
    if (updated.changes !== 1) {
      return false
    }
    recordForgeChange(ctx, request.itemId, 'run', request.runId, `cancel-${delivery}`)
    return true
  })
}

/** A runtime the old request never reached needs its own id; the host would answer a repeated one from its record. */
export function renewRunCancelOperation(
  ctx: ForgeLedgerContext,
  request: Pick<RunCancelRequest, 'runId' | 'operationId'>
): string | null {
  const operationId = mintRunCancelOperationId()
  const updated = ctx.db
    .prepare(
      `UPDATE runs SET cancel_operation_id = ?, cancel_delivery = NULL, cancel_fence = NULL,
         updated_at = ?
       WHERE id = ? AND cancel_operation_id = ? AND cancel_requested_at IS NOT NULL`
    )
    .run(operationId, ctx.now(), request.runId, request.operationId)
  return updated.changes === 1 ? operationId : null
}

/** Allowlisted facts only: when a stop was asked for and how far it got. */
export function readRunCancellationViews(
  ctx: ForgeLedgerContext,
  runIds: readonly number[]
): Map<number, ForgeRunCancellationView> {
  const views = new Map<number, ForgeRunCancellationView>()
  if (runIds.length === 0) {
    return views
  }
  const rows = ctx.db
    .prepare(
      `SELECT id, cancel_requested_at, cancel_delivery FROM runs
       WHERE cancel_requested_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(runIds))
  for (const row of rows) {
    const delivery = FORGE_RUN_CANCEL_DELIVERIES.find((known) => known === row.cancel_delivery)
    views.set(rowNumber(row, 'id'), {
      requestedAt: rowNumber(row, 'cancel_requested_at'),
      delivery: delivery ?? 'pending'
    })
  }
  return views
}
