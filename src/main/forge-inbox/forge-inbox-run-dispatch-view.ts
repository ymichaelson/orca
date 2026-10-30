import {
  FORGE_RUN_TERMINAL_EXIT_KINDS,
  type ForgeRunDispatchSnapshotView,
  type ForgeRunTerminalExitView
} from '../../shared/forge-inbox-run-dispatch'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber } from './forge-inbox-rows'

export type ForgeRunDispatchFacts = {
  snapshot?: ForgeRunDispatchSnapshotView
  terminalExit?: ForgeRunTerminalExitView
}

const MODEL_MAX_CHARS = 200

function modelText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MODEL_MAX_CHARS) : null
}

/** Allowlisted facts only: a known Agent, model text bounded in length, and fixed exit kinds. */
export function readRunDispatchFacts(
  ctx: ForgeLedgerContext,
  runIds: readonly number[]
): Map<number, ForgeRunDispatchFacts> {
  const facts = new Map<number, ForgeRunDispatchFacts>()
  if (runIds.length === 0) {
    return facts
  }
  const rows = ctx.db
    .prepare(
      `SELECT id, dispatch_agent_id, dispatch_requested_model, dispatch_actual_model,
         terminal_exit_kind, terminal_exit_value, terminal_exit_at
       FROM runs WHERE id IN (SELECT value FROM json_each(?))
         AND (dispatch_agent_id IS NOT NULL OR terminal_exit_kind IS NOT NULL)`
    )
    .all(JSON.stringify(runIds))
  for (const row of rows) {
    const entry: ForgeRunDispatchFacts = {}
    if (isTuiAgent(row.dispatch_agent_id)) {
      entry.snapshot = {
        agentId: row.dispatch_agent_id,
        requestedModel: modelText(row.dispatch_requested_model),
        actualModel: modelText(row.dispatch_actual_model)
      }
    }
    const kind = FORGE_RUN_TERMINAL_EXIT_KINDS.find((known) => known === row.terminal_exit_kind)
    if (kind !== undefined) {
      entry.terminalExit = {
        kind,
        value: typeof row.terminal_exit_value === 'number' ? row.terminal_exit_value : null,
        observedAt: rowNumber(row, 'terminal_exit_at')
      }
    }
    facts.set(rowNumber(row, 'id'), entry)
  }
  return facts
}
