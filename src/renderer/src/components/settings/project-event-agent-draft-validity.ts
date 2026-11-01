import { getAgentCatalog } from '@/lib/agent-catalog'
import type { ProjectEventPolicyView } from '../../../../shared/forge-inbox-project-event-policy'
import { MAX_RULES_BYTES } from '../../../../shared/forge-inbox-config'
import type { ProjectEventAgentDraft } from './use-project-event-agent-settings'

/** Rules are stored as UTF-8 bytes, so the limit is counted the same way the owner counts it. */
export function rulesByteLength(rules: string): number {
  return new TextEncoder().encode(rules).length
}

/** A new policy starts from the host's template; an existing one shows what the host has. */
export function draftFromPolicy(
  policy: ProjectEventPolicyView | null,
  defaultRules: string
): ProjectEventAgentDraft {
  return policy === null
    ? { enabled: false, agentId: null, model: '', rules: defaultRules }
    : {
        enabled: policy.enabled,
        agentId: policy.agentId,
        model: policy.model ?? '',
        rules: policy.rules
      }
}

function validAgent(value: string | null): boolean {
  return value !== null && getAgentCatalog().some((entry) => entry.id === value)
}

/** Enabling needs a real agent even when the saved draft's own validity is not required. */
export function hasValidAgent(value: string | null): boolean {
  return validAgent(value)
}

/** The same rules the owner enforces, checked before a write: bounded rules and a real agent. */
export function validDraft(
  candidate: ProjectEventAgentDraft,
  policy: ProjectEventPolicyView | null
): boolean {
  return (
    rulesByteLength(candidate.rules) <= MAX_RULES_BYTES &&
    !candidate.rules.includes('\u0000') &&
    (!candidate.enabled || validAgent(candidate.agentId)) &&
    (policy?.automaticAnalysis !== true ||
      (candidate.agentId !== null && candidate.agentId !== '' && candidate.model.trim() !== ''))
  )
}
