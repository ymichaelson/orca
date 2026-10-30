import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentLaunchModeSettings } from '../agent-launch/agent-launch-mode'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ProjectEventTerminalRuntime } from './forge-inbox-project-event-terminal-observer'
import type { ProjectEventRunCancelRuntime } from './forge-inbox-project-event-run-cancel'
import type { ProjectEventRunWatch } from './forge-inbox-project-event-run-watch'

export type ProjectEventAgentLaunchInput = {
  itemId: number
  repoId: string
  runId: number
  prompt: string
  /** The policy generation the prompt's rules were read from. */
  policyGeneration?: number
  requireStructuredProof?: boolean
}

export type ProjectEventAgentLaunchResult =
  | {
      ok: true
      mode: 'structured' | 'terminal'
      sessionId: string | null
      promptOutcome: 'journaled' | 'handed-to-terminal'
    }
  | { ok: false; code: string }

export type ProjectEventAgentLaunch = {
  (input: ProjectEventAgentLaunchInput): Promise<ProjectEventAgentLaunchResult>
  /** Fences every later effect at once and resolves when the stop jobs it owns have ended. */
  stop?: () => Promise<void>
  dispose?: () => void
}

/** Builds the launch one dispatch owns, so its stop never reaches the next dispatch's launch. */
export type ForgeProjectEventAgentLaunchFactory = (
  ledger: ForgeInboxLedger
) => ProjectEventAgentLaunch

/** A factory call the owner wraps, so the launch a dispatch builds stays fenced by the owner close. */
export type ForgeProjectEventAgentLaunchOpener = (
  factory: ForgeProjectEventAgentLaunchFactory,
  ledger: ForgeInboxLedger
) => ProjectEventAgentLaunch

/** Only what a dispatch reads from the host; structural so the launcher can be exercised without one. */
export type ProjectEventAgentLaunchRuntime = {
  requireStore(): {
    getSettings(): AgentLaunchModeSettings | null
    getRepo(id: string): { path: string; connectionId?: string | null } | undefined
  }
  getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: StructuredAgentId
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }>
  ensureStructuredAgentSessionHost(): Promise<void>
  launchAgentTerminal(
    worktreeSelector: string,
    options: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<{
    handle: string
    paneKey?: string | null
    /** The PTY identity the runtime reported for this terminal; absent when it named none. */
    ptyId?: string | null
    incarnationId?: string | null
    executionHostId?: ExecutionHostId
    worktreeId?: string
  }>
  resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: { path: string; id?: string; repoId?: string }
    executionHostId: ExecutionHostId
  }>
}

export type ProjectEventStructuredSessionCreate = (args: {
  ensureHost: () => Promise<StructuredAgentSessionHost>
  caller: { callerKey: string }
  envelope: {
    sessionId: string
    clientOperationId: string
    expectedRuntimeFence: null
    payloadFingerprint: string
  }
  worktree: string
  agent: StructuredAgentId
  activate: false
  options?: Readonly<Record<string, string>>
}) => Promise<
  | { ok: true; value: { sessionId: string; fence: number; tabId?: string } }
  | { ok: false; refusal: { code: string; message: string } }
>

export type ProjectEventAgentLaunchPorts = {
  runtime: ProjectEventAgentLaunchRuntime
  createStructuredSession: ProjectEventStructuredSessionCreate
  deliverStructuredPrompt: (args: {
    callerKey: string
    sessionId: string
    fence: number
    text: string
    clientMessageId: string
  }) => Promise<string | null>
  /** Follows the session's turn edge so the run ends on the agent's own verdict. */
  runWatch?: ProjectEventRunWatch
  /** Delivers the stop a policy change committed; without it a requested stop stays requested. */
  cancel?: ProjectEventRunCancelRuntime
  cancelRetryDelayMs?: number
  /** Watches a launched terminal's process and closes it on a stop; without it nothing observes one. */
  terminals?: ProjectEventTerminalRuntime
  /** The model the runtime itself reports for a created session, when it already knows one. */
  reportedModel?: (sessionId: string) => string | undefined
}
