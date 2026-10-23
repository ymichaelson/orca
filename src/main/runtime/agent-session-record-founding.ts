import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../shared/agent-chat-permission-mode'
import {
  isProtectedClaudeRecordBinding,
  type ProtectedClaudeLaunchV1
} from '../../shared/agent-session-protected-claude-launch'
import {
  AGENT_SESSION_PROTECTED_RECORD_SCHEMA_VERSION,
  PROTECTED_ANALYSIS_CONVERSATION_NAME,
  type AgentSessionProtectedAnalysis
} from '../../shared/agent-session-protected-analysis'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

/** Who a conversation's agent is and how it launches: the same whether it is created or founded. */
export type AgentSessionRecordIdentity = Pick<
  AgentSessionRecord,
  | 'sessionId'
  | 'location'
  | 'provider'
  | 'accountHome'
  | 'options'
  | 'launchArgs'
  | 'launchDirectory'
>

/** What a host founding may add; a reservation never carries it. */
export type AgentSessionFoundingIdentity = AgentSessionRecordIdentity & {
  protectedAnalysis?: AgentSessionProtectedAnalysis
  protectedClaudeLaunch?: ProtectedClaudeLaunchV1
}

export function agentSessionRecordIdentityFields(
  identity: AgentSessionRecordIdentity,
  now: number
) {
  // Callers name the mode among the options, as the wire does; the record keeps it as its own field.
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode, ...options } =
    identity.options ?? {}
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    location: identity.location,
    provider: identity.provider,
    accountHome: identity.accountHome,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(identity.launchArgs ? { launchArgs: [...identity.launchArgs] } : {}),
    // A /clear continues in the same tab, so it stays in the folder the chat ran in.
    ...(identity.launchDirectory ? { launchDirectory: identity.launchDirectory } : {}),
    createdAt: now,
    updatedAt: now
  }
}

/** The fence a founded conversation starts at; every reservation moves it. */
export const AGENT_SESSION_FOUNDING_FENCE = 1

/** A founded row with no reservation, owner, or provider handle has never started an agent. */
export function structuredSessionNeverStarted(record: AgentSessionRecord): boolean {
  const { lease } = record
  return (
    lease.claimStatus === 'released' &&
    lease.runtimeFence === AGENT_SESSION_FOUNDING_FENCE &&
    lease.minimumNextFence === undefined &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null &&
    lease.handoffStage === null &&
    record.providerHandleChain.length === 0
  )
}

/**
 * A conversation no agent has run yet, at rest: its first send starts one. The empty handle chain
 * is what makes that start a fresh conversation rather than a resume.
 */
export function foundAgentSessionRecord(
  identity: AgentSessionFoundingIdentity,
  lease: { claimKeyId: string; now: number }
): AgentSessionRecord {
  if (
    !isProtectedClaudeRecordBinding({
      ...identity,
      schemaVersion: identity.protectedAnalysis ? 3 : 2
    })
  ) {
    throw new Error('agent_session_store_write_invalid')
  }
  return {
    ...agentSessionRecordIdentityFields(identity, lease.now),
    ...(identity.protectedClaudeLaunch
      ? { protectedClaudeLaunch: structuredClone(identity.protectedClaudeLaunch) }
      : {}),
    ...(identity.protectedAnalysis
      ? {
          schemaVersion: AGENT_SESSION_PROTECTED_RECORD_SCHEMA_VERSION,
          conversationName: PROTECTED_ANALYSIS_CONVERSATION_NAME,
          protectedAnalysis: { ...identity.protectedAnalysis }
        }
      : {}),
    providerHandleChain: [],
    lease: {
      sessionId: identity.sessionId,
      runtimeKind: 'native',
      // Not 0: clients echo the fence as their expected fence, which the wire requires positive.
      runtimeFence: AGENT_SESSION_FOUNDING_FENCE,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: lease.now,
      lastRenewedAt: lease.now,
      handoffOperationId: null,
      claimKeyId: lease.claimKeyId,
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    }
  }
}
