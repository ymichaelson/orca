import { randomUUID } from 'node:crypto'
import { narrowStructuredLaunchSeedOptions } from '../../shared/native-chat-session-option-defaults'
import { createStructuredAgentSessionId } from '../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory
} from '../agent-launch/agent-launch-surface-factories'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ForgeLedgerContext } from './forge-inbox-context'
import type { ProjectEventAgentLaunchPorts } from './forge-inbox-project-event-agent-launch-types'
import {
  bindRunTerminal,
  recordDispatchActualModel
} from './forge-inbox-project-event-run-terminal-state'
import { bindForgeRunDispatchTurn, bindForgeRunSession, readForgeRun } from './forge-inbox-runs'

const TERMINAL_TITLE = 'Forge project event'

/** Kept under a Windows command line (about 32K, with quoting that can double); never truncated. */
const TERMINAL_PROMPT_MAX_CHARS = process.platform === 'win32' ? 12 * 1024 : 24 * 1024

/** Why a pending launch may no longer act; null while the policy, the run and this launcher still allow it. */
export type LaunchAdmission = () => 'owner-stopped' | 'policy-revoked' | null

export function admissionError(code: string): Error {
  return new Error(code.replaceAll('-', '_'))
}

function clearRunSession(ctx: ForgeLedgerContext, runId: number): void {
  ctx.db
    .prepare('UPDATE runs SET session_id = NULL, updated_at = ? WHERE id = ?')
    .run(ctx.now(), runId)
}

export function surfacesFor(args: {
  ctx: ForgeLedgerContext
  ports: ProjectEventAgentLaunchPorts
  runId: number
  promptText: string
  callerKey: string
  admit: LaunchAdmission
  onSendAttempted: () => void
  requireStructuredProof?: boolean
}): AgentLaunchSurfaceFactory {
  const { ctx, ports, runId, promptText, callerKey, admit } = args
  const assertAdmitted = (): void => {
    const refusal = admit()
    if (refusal) {
      throw admissionError(refusal)
    }
  }
  return {
    createStructuredSession: async ({ worktreeId, agent, options, tabId }) => {
      assertAdmitted()
      const sessionId = createStructuredAgentSessionId(agent, randomUUID)
      // Written before the create so a crash after the session exists still records where it is.
      if (!bindForgeRunSession(ctx, runId, sessionId)) {
        throw new Error('dispatch_session_unbound')
      }
      const seeded = narrowStructuredLaunchSeedOptions(options)
      let refusedBeforeCreate = false
      let created: Awaited<ReturnType<typeof ports.createStructuredSession>>
      try {
        created = await ports.createStructuredSession({
          ensureHost: async () => {
            await ports.runtime.ensureStructuredAgentSessionHost()
            // The last stop before the host commits a session, so a revoked launch creates none.
            const refusal = admit()
            if (refusal) {
              refusedBeforeCreate = true
              throw admissionError(refusal)
            }
            return requireStructuredHost()
          },
          caller: { callerKey },
          envelope: {
            sessionId,
            clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          worktree: `id:${worktreeId}`,
          agent,
          ...(seeded ? { options: seeded } : {}),
          ...(tabId ? { tabId } : {}),
          activate: false
        })
      } catch (error) {
        if (refusedBeforeCreate) {
          clearRunSession(ctx, runId)
        }
        throw error
      }
      const reported = created.ok ? ports.reportedModel?.(created.value.sessionId) : undefined
      if (reported) {
        recordDispatchActualModel(ctx, runId, reported)
      }
      if (!created.ok) {
        clearRunSession(ctx, runId)
        throw new AgentLaunchStructuredSessionRefusedError(
          created.refusal.code,
          created.refusal.message
        )
      }
      return {
        sessionId: created.value.sessionId,
        handle: structuredAgentSessionTabId(created.value.sessionId),
        fence: created.value.fence,
        ...(created.value.tabId ? { tabId: created.value.tabId } : {})
      }
    },
    deliverStructuredPrompt: async ({ sessionId, fence, prompt: { text } }) => {
      // A policy that moved during the create stops here with the session still recorded on the run.
      assertAdmitted()
      const clientMessageId = createStructuredAgentSessionOperationId(randomUUID)
      if (!bindForgeRunDispatchTurn(ctx, runId, clientMessageId)) {
        throw new Error('dispatch_turn_unbound')
      }
      const options = args.requireStructuredProof ? { exclusiveRunId: runId } : undefined
      ports.runWatch?.watch(sessionId, runId, clientMessageId, options)
      args.onSendAttempted()
      return ports.deliverStructuredPrompt({ callerKey, sessionId, fence, text, clientMessageId })
    },
    createTerminalAgent: async ({ worktreeId, agent, startupPrompt }) => {
      assertAdmitted()
      if (args.requireStructuredProof) {
        throw new Error('structured_agent_session_unsupported')
      }
      // Unlike a session, a terminal has no run-bound id that would refuse a run already settled.
      if (readForgeRun(ctx, runId)?.state !== 'running') {
        throw new Error('dispatch_failed')
      }
      // A terminal means no structured session exists, so a minted id from a refused create is not it.
      clearRunSession(ctx, runId)
      const text = startupPrompt ?? promptText
      if (text.length > TERMINAL_PROMPT_MAX_CHARS) {
        throw new Error('dispatch_prompt_too_large_for_terminal')
      }
      const launched = await ports.runtime.launchAgentTerminal(`id:${worktreeId}`, {
        agent,
        prompt: text,
        title: TERMINAL_TITLE
      })
      // Kept before anything else can happen, so a stop or a restart finds this exact PTY.
      bindRunTerminal(ctx, runId, {
        handle: launched.handle,
        ptyId: launched.ptyId ?? null,
        incarnationId: launched.incarnationId ?? null,
        executionHostId: launched.executionHostId ?? null,
        worktreeId: launched.worktreeId ?? worktreeId
      })
      return {
        handle: launched.handle,
        ...(launched.paneKey ? { paneKey: launched.paneKey } : {}),
        ...(text ? { promptRodeLaunchCommand: true as const } : {})
      }
    }
  }
}

export function requireStructuredHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}
