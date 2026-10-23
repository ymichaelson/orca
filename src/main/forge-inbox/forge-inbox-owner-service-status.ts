import type { ForgeOwnerRunning } from './forge-inbox-owner-running'

export type ForgeOwnerServicePhase = 'new' | 'running' | 'stopped'

export function forgeOwnerStatus(phase: ForgeOwnerServicePhase, state: ForgeOwnerRunning | null) {
  const work = state?.ledger.getWebhookWorkSchedule()
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
      pending: work?.pending ?? 0,
      needsAuth: work?.needsAuth ?? 0,
      nextAttemptAtMs: work?.nextAttemptAtMs ?? null,
      draining: state?.scheduler.status().draining ?? false
    }
  }
}

/** No drain running and nothing pending; parked needs-auth rows do not keep the host busy. */
export function forgeOwnerIdle(state: ForgeOwnerRunning | null): boolean {
  if (!state) {
    return true
  }
  return (
    !state.scheduler.status().draining &&
    state.analysis?.status().draining !== true &&
    state.ledger.getWebhookWorkSchedule().pending === 0
  )
}
