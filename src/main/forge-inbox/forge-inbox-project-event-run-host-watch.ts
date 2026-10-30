import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createForgeProjectEventRunWatch,
  type ProjectEventRunWatch
} from './forge-inbox-project-event-run-watch'
import { recoverInterruptedProjectEventRuns } from './forge-inbox-project-event-run-recovery'
import {
  readForgeProtectedTurnProof,
  readForgeProtectedTurnProofIfHosted
} from './forge-inbox-protected-turn-proof'
import { listInterruptedDispatchedForgeRuns } from './forge-inbox-runs'

/**
 * Follows the current host's feed. The registry listener starts with the first watched send, so a
 * launcher that is built but never used (a failed owner open) holds nothing to release.
 */
export function createForgeProjectEventRunHostWatch(
  ledger: ForgeInboxLedger
): ProjectEventRunWatch {
  let disposed = false
  let generation = 0
  let stopListening: (() => void) | null = null
  let watch: ProjectEventRunWatch | null = null

  function createWatch(): ProjectEventRunWatch {
    const host = getStructuredAgentSessionHost()
    return createForgeProjectEventRunWatch({
      ledger,
      readTurnProof: (sessionId, clientMessageId) =>
        readForgeProtectedTurnProofIfHosted(host, sessionId, clientMessageId),
      subscribeTurnCompletions: (subscriber) =>
        host ? host.subscribeTurnCompletions(subscriber) : () => undefined
    })
  }

  function dispose(): void {
    disposed = true
    generation++
    stopListening?.()
    stopListening = null
    watch?.dispose()
    watch = null
  }

  async function recoverOnto(
    next: ProjectEventRunWatch,
    host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
    fence: number
  ): Promise<void> {
    const isCurrent = () => !disposed && !ledger.isClosed() && generation === fence
    await recoverInterruptedProjectEventRuns({
      ledger,
      isCurrent,
      readTurnProof: (sessionId, clientMessageId) =>
        readForgeProtectedTurnProof(host, sessionId, clientMessageId)
    })
    if (!isCurrent()) {
      return
    }
    // A turn that had not finished yet settles from the new host's own completion event.
    for (const run of listInterruptedDispatchedForgeRuns(ledger.ledgerContext())) {
      next.watch(run.sessionId, run.id, run.clientMessageId)
    }
  }

  function onHostChanged(host: ReturnType<typeof getStructuredAgentSessionHost>): void {
    const fence = ++generation
    watch?.dispose()
    watch = null
    if (disposed || ledger.isClosed()) {
      dispose()
      return
    }
    const next = createWatch()
    watch = next
    if (host) {
      void recoverOnto(next, host, fence).catch(() => {
        // Host replacement cannot fail the host install or resurrect an uncertain send.
      })
    }
  }

  return {
    watch: (sessionId, runId, clientMessageId, options) => {
      if (disposed) {
        return
      }
      if (stopListening === null) {
        watch = createWatch()
        stopListening = onStructuredAgentSessionHostChanged(onHostChanged)
      }
      if (ledger.isClosed()) {
        dispose()
        return
      }
      if (watch?.isDisposed()) {
        watch = createWatch()
      }
      watch?.watch(sessionId, runId, clientMessageId, options)
    },
    dispose,
    isDisposed: () => disposed
  }
}
