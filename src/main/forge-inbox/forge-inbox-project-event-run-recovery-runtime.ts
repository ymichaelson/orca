import { withTimeout } from '../../shared/promise-timeout-fallback'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { recoverInterruptedProjectEventRuns } from './forge-inbox-project-event-run-recovery'
import { readForgeProtectedTurnProofIfHosted } from './forge-inbox-protected-turn-proof'
import { listInterruptedDispatchedForgeRuns } from './forge-inbox-runs'

const HOST_READY_TIMEOUT_MS = 5_000

export type ProjectEventRunRecoveryRuntimeDeps = {
  /** Builds the chat host on demand; a startup with nothing left over must not pay for one. */
  ensureHost: () => Promise<unknown>
}

/** Restart reconciliation against the real journal: a host that cannot prove a turn changes nothing. */
export function forgeInboxProjectEventRunRecoveryForRuntime(
  deps: ProjectEventRunRecoveryRuntimeDeps
): (ledger: ForgeInboxLedger) => Promise<void> {
  return async (ledger) => {
    if (listInterruptedDispatchedForgeRuns(ledger.ledgerContext()).length === 0) {
      return
    }
    // Owner open awaits this, so a stuck install must fall back to "unproven" and let startup go.
    await withTimeout(deps.ensureHost(), HOST_READY_TIMEOUT_MS, undefined)
    const host = getStructuredAgentSessionHost()
    const { recovered, unproven } = await recoverInterruptedProjectEventRuns({
      ledger,
      isCurrent: () => !ledger.isClosed(),
      readTurnProof: (sessionId, clientMessageId) =>
        readForgeProtectedTurnProofIfHosted(host, sessionId, clientMessageId)
    })
    if (recovered > 0) {
      console.info('[forge-inbox] recovered dispatched runs from the journal', {
        recovered,
        unproven
      })
    }
  }
}
