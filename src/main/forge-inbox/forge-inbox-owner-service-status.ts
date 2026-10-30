import { getProjectEventActionSchedule } from './forge-inbox-project-event-action'
import { getProjectEventDecisionSchedule } from './forge-inbox-project-event-decision'
import type { ForgeOwnerRunning } from './forge-inbox-owner-running'

export type ForgeOwnerServicePhase = 'new' | 'running' | 'stopped'

export function forgeOwnerStatus(phase: ForgeOwnerServicePhase, state: ForgeOwnerRunning | null) {
  const ctx = state?.ledger.ledgerContext()
  const decisions = ctx ? getProjectEventDecisionSchedule(ctx) : null
  const actions = ctx ? getProjectEventActionSchedule(ctx) : null
  const times = [decisions?.nextAttemptAtMs, actions?.nextAttemptAtMs].filter(
    (time): time is number => time != null
  )
  return {
    phase,
    running: state !== null,
    dormant: phase === 'running' && state === null,
    listener: state?.listener.status() ?? {
      enabled: false,
      listening: false,
      port: null,
      error: null
    },
    work: {
      pending: (decisions?.pending ?? 0) + (actions?.pending ?? 0),
      needsAuth: (decisions?.needsAuth ?? 0) + (actions?.needsAuth ?? 0),
      nextAttemptAtMs: times.length > 0 ? Math.min(...times) : null,
      draining:
        state?.decisions?.status().draining === true ||
        state?.actions.status().draining === true ||
        state?.confirmations?.status().draining === true
    }
  }
}

/** No drain running and nothing pending; parked needs-auth rows do not keep the host busy. */
export function forgeOwnerIdle(state: ForgeOwnerRunning | null): boolean {
  if (!state) {
    return true
  }
  return (
    state.decisions?.status().draining !== true &&
    state.actions.status().draining !== true &&
    state.confirmations?.status().draining !== true &&
    !state.ledger
      .ledgerContext()
      .db.prepare(`SELECT 1 FROM project_event_decisions d
      JOIN runs r ON r.id = d.run_id
      WHERE d.host_id = ? AND d.action = 'ask_user' AND d.action_state = 'blocked'
        AND d.last_error_code = 'preparing-question' AND r.state = 'running' LIMIT 1`)
      .get(state.ledger.hostId) &&
    getProjectEventDecisionSchedule(state.ledger.ledgerContext()).pending === 0 &&
    getProjectEventActionSchedule(state.ledger.ledgerContext()).pending === 0
  )
}
