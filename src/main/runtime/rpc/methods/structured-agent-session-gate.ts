// Require structured.v1 across every agentSession method before exposing journals or mutations.
// Legacy tab restore may still install the host for fallback rows; that never admits agentSession calls.

import { AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY } from '../../../../shared/agent-session-protected-output-capability'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { structuredAgentSessionHostRefusal } from '../../agent-session/structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  clientReadsStructuredSessionAgent,
  isStructuredNativeChatDefaultFor,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/** In-process callers share the host build; remote callers must advertise structured-session support. */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredAgentAudience(ctx: RpcContext, agent: string): void {
  requireStructuredCapability(ctx)
  if (!clientReadsStructuredSessionAgent(ctx, agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/** Only createSupport consults launch preference for legacy mode pickers, preserving their terminal-fallback refusal. */
export function requireStructuredCreateSupportAdmission(ctx: RpcContext, agent?: string): void {
  requireStructuredAgentAudience(ctx, agent ?? '')
  if (
    createSupportFollowsHostSetting(ctx) &&
    !isStructuredNativeChatDefaultFor(ctx.runtime, agent ?? '')
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredHost(ctx: RpcContext, agent?: string): StructuredAgentSessionHost {
  requireStructuredAgentAudience(ctx, agent ?? '')
  return requireHostOrRefusal()
}

export function requireStructuredSessionHost(
  ctx: RpcContext,
  sessionId: string
): StructuredAgentSessionHost {
  const host = requireStructuredHost(ctx)
  requireStructuredAgentAudience(ctx, host.sessionAgent(sessionId) ?? '')
  requireProtectedOutputReader(ctx, host, sessionId)
  return host
}

/**
 * Forge analysis of an MR is untrusted text a client may only be shown by a renderer that blocks
 * remote media, raw HTML and silent navigation. A client that has not said it does that is not
 * given the session at all — a gate on the transcript alone would leave the send, the item read and
 * the live streams open.
 */
export function clientReadsProtectedOutput(
  ctx: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY) === true
  )
}

/** True for an ordinary session, or a protected one whose reader claims inert rendering. */
export function clientReadsProtectedSession(
  ctx: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  host: Pick<StructuredAgentSessionHost, 'deps'>,
  sessionId: string
): boolean {
  if (host.deps.store.getRecord(sessionId)?.protectedAnalysis === undefined) {
    return true
  }
  return clientReadsProtectedOutput(ctx)
}

export function requireProtectedOutputReader(
  ctx: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  host: Pick<StructuredAgentSessionHost, 'deps'>,
  sessionId: string
): void {
  if (!clientReadsProtectedSession(ctx, host, sessionId)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/**
 * The gate for methods that stop or retire work the caller already owns: close, cancel,
 * unsubscribe and release. It asks only what no caller can do without (the wire capability and a
 * host), never an admission condition: refusing a close strands a live provider child its own
 * owner can no longer shut down. It is `requireStructuredHost` today; keep it apart so a condition
 * added there for new work never reaches these.
 */
export function requireStructuredCleanupHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  return requireHostOrRefusal()
}

/** Return the host or its failure, including journal-open refusal; this process cannot stop children it never started. */
function requireHostOrRefusal(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (host) {
    return host
  }
  throw (
    structuredAgentSessionHostRefusal() ??
    agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
  )
}

/** Build lazily before durable-record reads, including chats at rest after restart. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  agent?: string
): Promise<void> {
  if (agent) {
    requireStructuredAgentAudience(ctx, agent)
  }
  // Check capability before observable host installation.
  if (!supportsStructuredSessions(ctx)) {
    return
  }
  if (getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** The host for a read, built first when this process has none: the read RPCs share this one. */
export async function requireInstalledStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx)
  return sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireStructuredHost(ctx)
}

/** Persist/share proven paired device id, never clientId bearer credentials (for example, who answered a prompt). */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey:
      ctx.caller?.kind === 'paired-device'
        ? rpcCallerOperationKey(ctx.caller)
        : ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
