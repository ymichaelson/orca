import type { ForgeLedgerContext } from './forge-inbox-context'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'

export type ForgeDispatchedAgentIdentity = { sessionId?: string; terminalHandle?: string }

/** True only for the agent a project event dispatch started; the ordinary completion lane defers to Forge for it. */
export function isForgeDispatchedAgent(
  ctx: ForgeLedgerContext,
  identity: ForgeDispatchedAgentIdentity
): boolean {
  const sessionId = identity.sessionId ?? null
  const terminalHandle = identity.terminalHandle ?? null
  if (sessionId === null && terminalHandle === null) {
    return false
  }
  return (
    ctx.db
      .prepare(
        `SELECT 1 AS found FROM runs
         WHERE reason = ? AND ((? IS NOT NULL AND session_id = ?) OR (? IS NOT NULL AND terminal_handle = ?))
         LIMIT 1`
      )
      .get(
        PROJECT_EVENT_DISPATCH_RUN_REASON,
        sessionId,
        sessionId,
        terminalHandle,
        terminalHandle
      ) !== undefined
  )
}
