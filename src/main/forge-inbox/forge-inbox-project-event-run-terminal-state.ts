import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { finishDispatchConfirmationInTransaction } from './forge-inbox-dispatch-confirmation'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'
import { rowNumber, rowText } from './forge-inbox-rows'

export type RunTerminalIdentity = {
  handle: string
  ptyId: string | null
  incarnationId: string | null
  executionHostId: string | null
  worktreeId: string
}

export type RunTerminalExitKind = 'exited' | 'signaled' | 'operator_close' | 'unknown'

export type RunTerminalExit = {
  kind: RunTerminalExitKind
  /** The exit code, or the signal number; null when the host proved neither. */
  value: number | null
}

export type OpenTerminalRun = {
  runId: number
  itemId: number
  identity: RunTerminalIdentity
  cancelOperationId: string | null
  cancelDelivery: string | null
}

/** A terminal agent that has not been seen to exit, whose handoff already left its run unverifiable. */
export const OPEN_TERMINAL_RUN_SQL = `(r.state = 'unverifiable' AND r.error = 'terminal-handoff' AND r.terminal_handle IS NOT NULL AND r.terminal_exit_kind IS NULL)`

/** A terminal has no reply channel here, so there is never a report to check GitLab against. */
const NO_TERMINAL_REPORT = 'report-missing'

const EXIT_KINDS: readonly RunTerminalExitKind[] = [
  'exited',
  'signaled',
  'operator_close',
  'unknown'
]

/** The PTY a launch returned is recorded once; only the handle may be refreshed by the current runtime. */
export function bindRunTerminal(
  ctx: ForgeLedgerContext,
  runId: number,
  identity: RunTerminalIdentity
): boolean {
  const updated = ctx.db
    .prepare(
      `UPDATE runs SET terminal_handle = ?, terminal_pty_id = ?, terminal_incarnation_id = ?,
         terminal_execution_host_id = ?, terminal_worktree_id = ?, updated_at = ?
       WHERE id = ? AND terminal_handle IS NULL AND state IN ('running', 'unverifiable')`
    )
    .run(
      identity.handle,
      identity.ptyId,
      identity.incarnationId,
      identity.executionHostId,
      identity.worktreeId,
      ctx.now(),
      runId
    )
  return updated.changes === 1
}

export function refreshRunTerminalHandle(
  ctx: ForgeLedgerContext,
  runId: number,
  handle: string
): void {
  ctx.db
    .prepare(
      'UPDATE runs SET terminal_handle = ? WHERE id = ? AND terminal_handle IS NOT NULL AND terminal_exit_kind IS NULL'
    )
    .run(handle, runId)
}

export function listOpenTerminalRuns(ctx: ForgeLedgerContext): OpenTerminalRun[] {
  return ctx.db
    .prepare(
      `SELECT r.id, r.item_id, r.terminal_handle, r.terminal_pty_id, r.terminal_incarnation_id,
         r.terminal_execution_host_id, r.terminal_worktree_id, r.cancel_operation_id,
         r.cancel_delivery
       FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.host_id = ? AND r.reason = ? AND ${OPEN_TERMINAL_RUN_SQL}
         AND r.terminal_worktree_id IS NOT NULL
       ORDER BY r.id`
    )
    .all(ctx.hostId, PROJECT_EVENT_DISPATCH_RUN_REASON)
    .map((row) => ({
      runId: rowNumber(row, 'id'),
      itemId: rowNumber(row, 'item_id'),
      identity: {
        handle: rowText(row, 'terminal_handle'),
        ptyId: typeof row.terminal_pty_id === 'string' ? row.terminal_pty_id : null,
        incarnationId:
          typeof row.terminal_incarnation_id === 'string' ? row.terminal_incarnation_id : null,
        executionHostId:
          typeof row.terminal_execution_host_id === 'string'
            ? row.terminal_execution_host_id
            : null,
        worktreeId: rowText(row, 'terminal_worktree_id')
      },
      cancelOperationId:
        typeof row.cancel_operation_id === 'string' ? row.cancel_operation_id : null,
      cancelDelivery: typeof row.cancel_delivery === 'string' ? row.cancel_delivery : null
    }))
}

/**
 * What the process did, kept apart from what the agent did: a process that ended says nothing about
 * GitLab, so the run stays unverifiable and its effect row is closed as unconfirmable.
 */
export function recordRunTerminalExit(
  ctx: ForgeLedgerContext,
  run: Pick<OpenTerminalRun, 'runId' | 'itemId'>,
  exit: RunTerminalExit
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const updated = ctx.db
      .prepare(
        `UPDATE runs SET terminal_exit_kind = ?, terminal_exit_value = ?, terminal_exit_at = ?,
           updated_at = ?
         WHERE id = ? AND terminal_exit_kind IS NULL AND terminal_handle IS NOT NULL`
      )
      .run(exit.kind, exit.value, ctx.now(), ctx.now(), run.runId)
    if (updated.changes !== 1) {
      return false
    }
    finishDispatchConfirmationInTransaction(ctx, run, {
      state: 'unconfirmable',
      evidenceJson: JSON.stringify({
        attempts: 0,
        checkedAt: ctx.now(),
        code: NO_TERMINAL_REPORT,
        claims: []
      })
    })
    recordForgeChange(ctx, run.itemId, 'run', run.runId, 'terminal-exited')
    return true
  })
}

/** The Agent and model a dispatch was told to use; written once, so a later policy never rewrites it. */
export function bindDispatchSnapshot(
  ctx: ForgeLedgerContext,
  runId: number,
  snapshot: { agentId: string; requestedModel: string | null }
): void {
  ctx.db
    .prepare(
      `UPDATE runs SET dispatch_agent_id = ?, dispatch_requested_model = ?, updated_at = ?
       WHERE id = ? AND dispatch_agent_id IS NULL`
    )
    .run(snapshot.agentId, snapshot.requestedModel, ctx.now(), runId)
}

/** Only a model the runtime itself reported; never inferred from a catalog or probed for. */
export function recordDispatchActualModel(
  ctx: ForgeLedgerContext,
  runId: number,
  model: string
): void {
  ctx.db
    .prepare(
      `UPDATE runs SET dispatch_actual_model = ?
       WHERE id = ? AND dispatch_agent_id IS NOT NULL AND dispatch_actual_model IS NULL`
    )
    .run(model, runId)
}

export function readRunTerminalExitKind(value: unknown): RunTerminalExitKind | null {
  return EXIT_KINDS.find((kind) => kind === value) ?? null
}
