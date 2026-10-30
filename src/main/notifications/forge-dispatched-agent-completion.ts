import type { AgentStatusState } from '../../shared/agent-status-types'

type ForgeDispatchedAgentSource = {
  isDispatchedAgent(identity: { sessionId?: string; terminalHandle?: string }): boolean
}

export type ForgeDispatchedAgentCompletionDeps = {
  /** Null when no inbox is attached to this runtime. */
  forgeInbox: () => ForgeDispatchedAgentSource | null
  terminalHandleForPaneKey: (paneKey: string) => string | null
}

export type ForgeDispatchedAgentCompletion = {
  /**
   * A finished turn of an agent a project event dispatch started: the Forge verdict alert reports
   * it under the Inbox preferences, so the ordinary completion alert must not repeat or bypass them.
   * Prompts that need the user are not completions and stay with the ordinary lane.
   */
  defersToForge(identity: {
    state: AgentStatusState | undefined
    sessionId?: string
    paneKey?: string
  }): boolean
}

export function createForgeDispatchedAgentCompletion(
  deps: ForgeDispatchedAgentCompletionDeps
): ForgeDispatchedAgentCompletion {
  return {
    defersToForge: ({ state, sessionId, paneKey }) => {
      if (state !== 'done') {
        return false
      }
      try {
        const inbox = deps.forgeInbox()
        if (!inbox) {
          return false
        }
        const terminalHandle = paneKey ? deps.terminalHandleForPaneKey(paneKey) : null
        return inbox.isDispatchedAgent({
          ...(sessionId ? { sessionId } : {}),
          ...(terminalHandle ? { terminalHandle } : {})
        })
      } catch {
        // A stopped inbox cannot say, and a lookup failure must never swallow an ordinary alert.
        return false
      }
    }
  }
}
