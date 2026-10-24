import { join } from 'node:path'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import { protectedClaudePrivatePath } from '../../shared/agent-session-protected-claude-launch'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../shared/agent-session-wire-refusals'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { workspaceKindForWorktreeId } from '../../shared/workspace-launch-kind'
import type {
  ProtectedClaudeAuthDeps,
  ProtectedClaudeAuthSource
} from '../claude/claude-protected-auth'
import type { ProtectedClaudeExecutable } from '../claude/claude-protected-native-profile'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { prepareProtectedClaudeFounding } from '../runtime/agent-session-protected-claude-founding'
import type { ForgeAnalysisLaunch } from './forge-inbox-analysis-launch'
import {
  sendForgeProtectedSessionTurn,
  type ForgeProtectedSessionTurnHost
} from './forge-inbox-protected-session-turn'
import type {
  ForgeProtectedAnalysisFounding,
  ForgeProtectedAnalysisOpenRequest,
  ForgeProtectedAnalysisSession
} from './forge-inbox-protected-turn'

/** What the host's structured session store must offer; wider than a fake needs, no more. */
export type ForgeAnalysisHostPort = Pick<
  StructuredAgentSessionHost,
  'create' | 'send' | 'waitForSendSettlement' | 'history' | 'subscribeTurnCompletions'
> &
  Pick<ForgeProtectedSessionTurnHost, 'currentWork' | 'sessionRecord'>

export type ForgeInboxAnalysisPrepareInput = {
  sessionId: string
  subject: AgentSessionProtectedAnalysis
  launch: ForgeAnalysisLaunch
}

export type ForgeInboxAnalysisHostDeps = {
  stateDirectory: string
  auth: Omit<ProtectedClaudeAuthDeps, 'stateDirectory'>
  /** Folded into the private root admission so no scan root may contain it. */
  scanRoots: () => readonly string[] | Promise<readonly string[]>
  /** The workspace's directory on this host, or null when it is not one this host can run in. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string | null>
  ensureHost: () => Promise<ForgeAnalysisHostPort>
  resolveExecutablePath?: () => Promise<string>
  inspectExecutable?: (path: string) => Promise<ProtectedClaudeExecutable>
}

export type ForgeInboxAnalysisHost = {
  prepare: (input: ForgeInboxAnalysisPrepareInput) => Promise<ForgeProtectedAnalysisFounding>
  openSession: (input: ForgeProtectedAnalysisOpenRequest) => Promise<ForgeProtectedAnalysisSession>
}

/** A create the host refused: the wire code is both the message and the log label. */
export class ForgeAnalysisSessionRefusedError extends Error {
  readonly code: string
  constructor(readonly refusal: AgentSessionWireRefusal) {
    super(refusal.code)
    this.name = 'ForgeAnalysisSessionRefusedError'
    this.code = refusal.code
  }
}

export function createForgeInboxAnalysisHost(
  deps: ForgeInboxAnalysisHostDeps
): ForgeInboxAnalysisHost {
  // The founding is the only object that travels from `prepare` to `openSession`; the location it
  // was prepared for rides on it rather than on a table keyed by an id an aborted turn may never get.
  const locations = new WeakMap<ForgeProtectedAnalysisFounding, AgentSessionExecutionLocation>()

  return {
    prepare: async ({ sessionId, launch }) => {
      if (launch.agentId !== 'claude') {
        throw new Error('forge_analysis_agent_unsupported')
      }
      const { workspaceId } = launch
      if (!workspaceId) {
        throw new Error('forge_analysis_workspace_unavailable')
      }
      const workspaceKind = workspaceKindForWorktreeId(workspaceId)
      if (workspaceKind === 'floating' || (await deps.resolveWorkspacePath(workspaceId)) === null) {
        throw new Error('forge_analysis_workspace_unavailable')
      }
      const location: AgentSessionExecutionLocation = {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId,
        workspaceKind
      }
      const founding = await prepareProtectedClaudeFounding(
        {
          sessionId,
          provider: 'claude',
          model: launch.model,
          location,
          launchDirectory: protectedClaudePrivatePath(
            join(deps.stateDirectory, 'forge-protected-analysis', sessionId),
            'work'
          ),
          authSource: savedAgentEnvSource(deps.auth)
        },
        {
          stateDirectory: deps.stateDirectory,
          scanRoots: await deps.scanRoots(),
          auth: { ...deps.auth, stateDirectory: deps.stateDirectory },
          ...(deps.resolveExecutablePath
            ? { resolveExecutablePath: deps.resolveExecutablePath }
            : {}),
          ...(deps.inspectExecutable ? { inspectExecutable: deps.inspectExecutable } : {})
        }
      )
      locations.set(founding, location)
      return founding
    },

    openSession: async ({ sessionId, subject, founding }) => {
      const location = locations.get(founding)
      if (!location) {
        throw new Error('forge_analysis_session_unavailable')
      }
      const host = await deps.ensureHost()
      const callerKey = `forge-analysis:${sessionId}`
      const created = await host.create(
        { callerKey },
        {
          envelope: {
            sessionId,
            clientOperationId: sessionId,
            expectedRuntimeFence: null,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.create',
              sessionId,
              fields: {
                location,
                accountHome: founding.accountHome,
                options: founding.options,
                protectedAnalysis: subject
              }
            })
          },
          location,
          provider: 'claude',
          agent: 'claude',
          accountHome: founding.accountHome,
          runtimeKind: 'native',
          options: founding.options
        },
        {
          protection: {
            protectedAnalysis: subject,
            protectedClaudeLaunch: founding.protectedClaudeLaunch
          }
        }
      )
      if (!created.ok) {
        throw new ForgeAnalysisSessionRefusedError(created.refusal)
      }
      const { fence } = created
      return {
        sendTurn: async (prompt, signal) => {
          const outcome = await sendForgeProtectedSessionTurn({
            host,
            callerKey,
            sessionId,
            fence,
            prompt,
            signal
          })
          return outcome.kind === 'reply' ? outcome.text : null
        }
      }
    }
  }
}

/** Saved settings are the only auth this profile takes; an ambient login is never inherited. */
function savedAgentEnvSource(
  auth: Omit<ProtectedClaudeAuthDeps, 'stateDirectory'>
): ProtectedClaudeAuthSource {
  const env = auth.getSettings().agentDefaultEnv?.claude ?? {}
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const
  const present = keys.filter((key) => Boolean(env[key]))
  // Two keys would mean choosing one for the user, and the CLI runs on exactly one.
  if (present.length !== 1) {
    throw new Error('forge_analysis_auth_unavailable')
  }
  return { kind: 'saved-agent-env', credentialKey: present[0] }
}
