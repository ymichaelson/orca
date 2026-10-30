import type { ForgeLedgerContext } from './forge-inbox-context'
import { resumeParkedProjectEventDeliveries } from './forge-inbox-project-event-delivery'
import { getProjectEventRepoLink } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'

/**
 * Receiving for a repository becomes real only when both its binding and its enabled policy exist,
 * so every step that can complete that pair resumes what was parked waiting for it.
 */
export function resumeProjectEventDeliveriesForRepo(
  ctx: ForgeLedgerContext,
  repoId: string
): number {
  const link = getProjectEventRepoLink(ctx, repoId)
  if (!link) {
    return 0
  }
  const policy = getProjectEventPolicy(ctx, repoId)
  if (!policy?.enabled) {
    return 0
  }
  return resumeParkedProjectEventDeliveries(ctx, {
    bindingId: link.bindingId,
    policyGeneration: policy.generation
  })
}
