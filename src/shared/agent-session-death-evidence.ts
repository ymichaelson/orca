import type { AgentSessionDeathEvidence } from './agent-session-record'

const MAX_EVIDENCE_STRING_LENGTH = 512
/** A death evidence's `detail` past this fails a load, so whoever writes one cuts it here. */
export const MAX_AGENT_SESSION_DEATH_DETAIL_CHARS = MAX_EVIDENCE_STRING_LENGTH

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const evidence = value as Partial<AgentSessionDeathEvidence>
  const { observedAt, lastProvenAliveAt, ownerFence, runtimeEnd } = evidence
  return (
    (evidence.kind === 'exit-observed' ||
      evidence.kind === 'pid-absent' ||
      evidence.kind === 'identity-mismatch') &&
    isBoundedString(evidence.detail, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS) &&
    typeof observedAt === 'number' &&
    Number.isSafeInteger(observedAt) &&
    observedAt >= 0 &&
    (ownerFence === undefined || (Number.isSafeInteger(ownerFence) && ownerFence >= 0)) &&
    (lastProvenAliveAt === undefined ||
      (Number.isSafeInteger(lastProvenAliveAt) &&
        lastProvenAliveAt >= 0 &&
        lastProvenAliveAt <= observedAt)) &&
    (runtimeEnd === undefined || isBoundedString(runtimeEnd, MAX_EVIDENCE_STRING_LENGTH))
  )
}
