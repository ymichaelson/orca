import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'

export type ProjectEventDispatchPolicy = {
  generation: number
  agentId: TuiAgent
  /** Null means the Agent's own default; no model override is sent. */
  model: string | null
  rules: string
}

/** The enabled per-repo policy of the repo linked to the item's binding, or null to fail closed. */
export function resolveProjectEventDispatchPolicy(
  ctx: ForgeLedgerContext,
  itemId: number,
  repoId: string
): ProjectEventDispatchPolicy | null {
  // A project-event item is identified by GitLab host and path, so its binding names the linked repo.
  const linked = ctx.db
    .prepare(
      `SELECT 1 FROM items i
       JOIN project_bindings b ON i.instance_id = ? || b.gitlab_host
         AND i.project_id = b.gitlab_path
       JOIN project_event_repo_links l ON l.binding_id = b.binding_id AND l.host_id = i.host_id
       WHERE i.id = ? AND i.host_id = ? AND l.repo_id = ?`
    )
    .get(BINDING_INSTANCE_PREFIX, itemId, ctx.hostId, repoId)
  if (!linked) {
    return null
  }
  const policy = getProjectEventPolicy(ctx, repoId)
  if (!policy?.enabled || !policy.agentId || !isTuiAgent(policy.agentId)) {
    return null
  }
  return {
    generation: policy.generation,
    agentId: policy.agentId,
    model: policy.model ? policy.model : null,
    rules: policy.rules
  }
}
