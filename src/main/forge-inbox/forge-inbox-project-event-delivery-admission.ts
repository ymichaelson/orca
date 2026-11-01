import type { ForgeLedgerContext } from './forge-inbox-context'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'
import type { ProjectEventDeliveryAdmission } from './forge-inbox-project-event-delivery'

/** Facts that belong to the repository rather than to one merge request, issue or note. */
const PROJECT_LEVEL_KINDS: ReadonlySet<string> = new Set([
  'push',
  'tag_push',
  'release',
  'deployment'
])

function factKind(body: Buffer): string | null {
  try {
    const kind = projectEventDecisionFacts(body).kind
    return typeof kind === 'string' ? kind : null
  } catch {
    return null
  }
}

/**
 * A project-level event has no GitLab object to read back, so it is decided at once: a push opens its
 * own item and an agent policy can be invited on it. Anything about one merge request, issue or note
 * still waits for a policy, because turning one on later must not replay history.
 */
export function projectEventDeliveryAdmission(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; body: Buffer }
): Omit<ProjectEventDeliveryAdmission, 'body' | 'eventKind' | 'dedupeKey' | 'correlation'> & {
  recordWithoutPolicy: boolean
} {
  const link = getProjectEventRepoLinkByBinding(ctx, input.bindingId)
  const policy = link ? getProjectEventPolicy(ctx, link.repoId) : null
  const binding = ctx.db
    .prepare('SELECT gitlab_path FROM project_bindings WHERE binding_id = ?')
    .get(input.bindingId)
  // The stored project id is the GitLab path: it is what an item's notifications key on.
  const projectPath = typeof binding?.gitlab_path === 'string' ? binding.gitlab_path : ''
  if (policy) {
    return {
      bindingId: input.bindingId,
      projectPath,
      policyGeneration: policy.generation,
      policyEnabled: policy.enabled,
      recordWithoutPolicy: false
    }
  }
  const kind = factKind(input.body)
  const recordWithoutPolicy = kind !== null && PROJECT_LEVEL_KINDS.has(kind)
  return {
    bindingId: input.bindingId,
    projectPath,
    policyGeneration: null,
    policyEnabled: recordWithoutPolicy,
    recordWithoutPolicy
  }
}
