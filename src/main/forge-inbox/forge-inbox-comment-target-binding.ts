import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import type { ForgeLedgerContext } from './forge-inbox-context'
import type { GitlabBindingCommentScope } from './forge-inbox-gitlab-binding-comment'
import {
  BINDING_INSTANCE_PREFIX,
  getProjectBindingByGitlabPath
} from './forge-inbox-project-binding'

/**
 * A binding item names its GitLab path, not the numeric project id the API needs, so the binding is
 * looked up by (host, path). No binding means no destination: legacy instance credentials never
 * stand in for a binding write.
 */
export function bindingCommentScopeForTarget(
  ctx: ForgeLedgerContext,
  target: ForgeCommentTarget
): GitlabBindingCommentScope | null {
  if (!target.instanceId.startsWith(BINDING_INSTANCE_PREFIX)) {
    return null
  }
  const host = target.instanceId.slice(BINDING_INSTANCE_PREFIX.length)
  if (!host) {
    return null
  }
  const binding = getProjectBindingByGitlabPath(ctx, host, target.projectId)
  return binding === null
    ? null
    : {
        host: binding.gitlabHost,
        projectId: String(binding.gitlabProjectId),
        repoPath: binding.projectPath
      }
}
