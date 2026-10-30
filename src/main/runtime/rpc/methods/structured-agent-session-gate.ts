// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one gate governs the whole surface: a client that does
// not advertise `agent-session.structured.v1` is told the surface does not exist rather than being
// handed the session journal or mutation surface.
//
// This gate does not imply such a client cannot make the host exist: session-tab restore runs for
// old mobile clients so they receive a fallback row, and that path constructs the host.
// `agentSession.*` stays refused either way, which is what this gate is for.

import { AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY } from '../../../../shared/agent-session-protected-output-capability'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { structuredAgentSessionHostRefusal } from '../../structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  clientReadsStructuredSessionAgent,
  isStructuredNativeChatDefaultFor,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
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

/**
 * `agentSession.createSupport` alone also reads the host setting, for a client that leaves the
 * launch mode to the host; it gets the refusal it got before, which it reads as "open a terminal".
 */
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

/**
 * The host, or why there is none. A process whose journal would not open says so under every
 * getter, close included: nothing here can stop a child it never started.
 */
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

/** Builds the host for a call that may be the first this process sees. Every session is addressed
 *  by its durable record — a read opens a conversation at rest — so each call that reaches for one
 *  may meet a host nothing has built yet. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  agent?: string
): Promise<void> {
  if (agent) {
    requireStructuredAgentAudience(ctx, agent)
  }
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  if (!supportsStructuredSessions(ctx)) {
    return
  }
  if (getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** The session's host for a read that returns no transcript: modelCatalog answers only `unknown`
 *  for a protected record, so the protected-output capability is not required. */
export async function requireInstalledStructuredMetadataHost(
  ctx: RpcContext,
  sessionId: string
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx)
  const host = requireStructuredHost(ctx)
  requireStructuredAgentAudience(ctx, host.sessionAgent(sessionId) ?? '')
  return host
}

/** The host for a read, built first when this process has none: the read RPCs share this one. */
export async function requireInstalledStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx)
  return sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireStructuredHost(ctx)
}

/** A paired device's `clientId` is its bearer credential, and this key is stored and shown to other
 *  clients (who answered a prompt), so a paired device is named by its proven device id instead. */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey:
      ctx.caller?.kind === 'paired-device'
        ? rpcCallerOperationKey(ctx.caller)
        : ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
