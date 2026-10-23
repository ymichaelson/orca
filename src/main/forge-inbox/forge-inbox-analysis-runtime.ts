import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { MainHttpClient } from '../network/http-client'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'
import type { ProtectedClaudeExecutable } from '../claude/claude-protected-native-profile'
import { configureProtectedClaudeLaunchSources } from '../claude/claude-protected-launch-sources'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { protectedClaudeScanRoots } from '../claude/claude-protected-scan-roots'
import type { ForgeAnalysisRunnerFactory } from './forge-inbox-owner-service'
import { createForgeProtectedAnalysisRunner } from './forge-inbox-analysis-adapter'
import {
  createForgeInboxAnalysisHost,
  type ForgeAnalysisHostPort,
  type ForgeInboxAnalysisHostDeps
} from './forge-inbox-analysis-host'
import { createForgeInboxAnalysisTurn } from './forge-inbox-analysis-launch'

/** What a host shell must supply: its own state directory, settings, workspaces and session host. */
export type ForgeInboxRuntimeAnalysisDeps = {
  stateDirectory: string
  getSettings: ProtectedClaudeAuthDeps['getSettings']
  scanRoots: ForgeInboxAnalysisHostDeps['scanRoots']
  resolveWorkspacePath: ForgeInboxAnalysisHostDeps['resolveWorkspacePath']
  ensureHost: () => Promise<ForgeAnalysisHostPort>
  resolveExecutablePath?: () => Promise<string>
  inspectExecutable?: (path: string) => Promise<ProtectedClaudeExecutable>
}

/**
 * The production `analyse` a host injects. It also installs the protected launch sources, because
 * the structured session registry refuses a protected Claude launch until they exist.
 */
export function createForgeInboxRuntimeAnalysis(input: {
  runtime: ForgeInboxRuntimeAnalysisDeps
  http: Pick<MainHttpClient, 'fetch'>
}): ForgeAnalysisRunnerFactory {
  const { runtime } = input
  configureProtectedClaudeLaunchSources({
    getSettings: runtime.getSettings,
    scanRoots: runtime.scanRoots
  })
  const host = createForgeInboxAnalysisHost({
    stateDirectory: runtime.stateDirectory,
    auth: { getSettings: runtime.getSettings },
    scanRoots: runtime.scanRoots,
    resolveWorkspacePath: runtime.resolveWorkspacePath,
    ensureHost: runtime.ensureHost,
    ...(runtime.resolveExecutablePath
      ? { resolveExecutablePath: runtime.resolveExecutablePath }
      : {}),
    ...(runtime.inspectExecutable ? { inspectExecutable: runtime.inspectExecutable } : {})
  })
  return (ledger) =>
    createForgeProtectedAnalysisRunner({
      ledger,
      http: input.http,
      turn: createForgeInboxAnalysisTurn({
        ledger,
        prepare: host.prepare,
        openSession: host.openSession
      })
    })
}

/** The runtime surface a host shell must expose; kept structural so the shell need not be imported. */
export type ForgeInboxAnalysisRuntimeBinding = {
  /** Read per call: the active profile's settings, not whatever was current at construction. */
  requireStore: () => { getSettings: ProtectedClaudeAuthDeps['getSettings'] }
  resolveRuntimeFileTarget: (selector: string) => Promise<{
    worktree: { path: string }
    executionHostId: ExecutionHostId
  }>
  ensureStructuredAgentSessionHost: () => Promise<void>
}

/** Wires the production analysis into a runtime that owns this profile's structured session host. */
export function forgeInboxAnalysisForRuntime(input: {
  runtime: ForgeInboxAnalysisRuntimeBinding
  http: Pick<MainHttpClient, 'fetch'>
}): ForgeAnalysisRunnerFactory {
  return createForgeInboxRuntimeAnalysis({
    runtime: {
      stateDirectory: getProfileUserDataPath(),
      getSettings: () => input.runtime.requireStore().getSettings(),
      scanRoots: protectedClaudeScanRoots,
      resolveWorkspacePath: (workspaceId) => forgeAnalysisWorkspacePath(input.runtime, workspaceId),
      ensureHost: () => forgeAnalysisSessionHost(input.runtime)
    },
    http: input.http
  })
}

/** A workspace on another host has no directory here, so its analysis must not run in this runtime. */
export async function forgeAnalysisWorkspacePath(
  runtime: Pick<ForgeInboxAnalysisRuntimeBinding, 'resolveRuntimeFileTarget'>,
  workspaceId: string
): Promise<string | null> {
  try {
    const target = await runtime.resolveRuntimeFileTarget(`id:${workspaceId}`)
    return target.executionHostId === LOCAL_EXECUTION_HOST_ID ? target.worktree.path : null
  } catch {
    return null
  }
}

/** Starts no session: an unwired host is refused by the runner rather than silently analysed elsewhere. */
export async function forgeAnalysisSessionHost(
  runtime: Pick<ForgeInboxAnalysisRuntimeBinding, 'ensureStructuredAgentSessionHost'>
): Promise<StructuredAgentSessionHost> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_host_unavailable')
  }
  return host
}
