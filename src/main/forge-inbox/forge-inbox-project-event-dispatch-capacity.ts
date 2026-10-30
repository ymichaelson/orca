import type { ForgeLedgerContext } from './forge-inbox-context'
import { FORGE_COORDINATOR_DEFAULTS } from './forge-inbox-coordinator'
import { OPEN_DISPATCH_RUN_SQL } from './forge-inbox-project-event-run-cancel-state'

// A stop receipt is not an exit; a proven terminal exit releases execution, not task/effect success.
const OCCUPIED_RUN_SQL = `r.terminal_exit_kind IS NULL AND
  (${OPEN_DISPATCH_RUN_SQL} OR r.state = 'awaiting-approval')`

/** Correlated with binding b; the owner expression is supplied only by the ledger's own queries. */
export function projectEventDispatchCapacitySql(ownerHostSql: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM runs r JOIN run_dispatch_confirmations c ON c.run_id = r.id
    WHERE c.host_id = ${ownerHostSql} AND c.gitlab_host = b.gitlab_host
      AND c.gitlab_project_id = b.gitlab_project_id AND ${OCCUPIED_RUN_SQL})
    AND (SELECT COUNT(*) FROM runs r JOIN items occupied_item ON occupied_item.id = r.item_id
      WHERE occupied_item.host_id = ${ownerHostSql} AND ${OCCUPIED_RUN_SQL})
      < ${FORGE_COORDINATOR_DEFAULTS.maxConcurrentRuns}`
}

/** The caller holds the admission transaction until its run and frozen project identity are written. */
export function hasProjectEventDispatchCapacity(
  ctx: ForgeLedgerContext,
  bindingId: string
): boolean {
  return (
    ctx.db
      .prepare(`SELECT 1 FROM project_bindings b
      WHERE b.binding_id = ? AND ${projectEventDispatchCapacitySql('?')}`)
      .get(bindingId, ctx.hostId, ctx.hostId) !== undefined
  )
}
