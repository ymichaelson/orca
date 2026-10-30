import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ProjectEventRunCancelRuntime } from './forge-inbox-project-event-run-cancel'
import type { ProjectEventTerminalRuntime } from './forge-inbox-project-event-terminal-observer'

const HOST_READY_TIMEOUT_MS = 5_000

/** The registry's current host, so a stop reaches whichever host owns the session now, never a cached one. */
export function projectEventRunCancelRuntimeFor(runtime: {
  ensureStructuredAgentSessionHost(): Promise<void>
}): ProjectEventRunCancelRuntime {
  return {
    host: async () => {
      await withTimeout(
        runtime.ensureStructuredAgentSessionHost(),
        HOST_READY_TIMEOUT_MS,
        undefined
      )
      return getStructuredAgentSessionHost()
    },
    onHostChanged: (listener) => onStructuredAgentSessionHostChanged(() => listener())
  }
}

/** The runtime's own terminal queries and close: no other adapter, no signal, no tab close. */
export function projectEventTerminalRuntimeFor(
  runtime: Pick<OrcaRuntimeService, 'waitForTerminal' | 'closeTerminal' | 'listTerminals'>
): ProjectEventTerminalRuntime {
  return {
    waitForTerminal: (handle, options) => runtime.waitForTerminal(handle, options),
    closeTerminal: (handle) => runtime.closeTerminal(handle),
    listTerminals: (worktreeSelector, limit, options) =>
      runtime.listTerminals(worktreeSelector, limit, options)
  }
}

/** The model the host's own status row reports for a created session; absent until it has read one. */
export function reportedModelOfStructuredSession(sessionId: string): string | undefined {
  return getStructuredAgentSessionHost()?.readStatusSummary(sessionId)?.model
}
