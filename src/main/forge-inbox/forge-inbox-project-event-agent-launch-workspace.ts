import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import type { ProjectEventAgentLaunchRuntime } from './forge-inbox-project-event-agent-launch-types'

export type RepoWorkspace = { ok: true; worktreeId: string } | { ok: false; code: string }

export async function resolveRepoWorkspace(
  runtime: ProjectEventAgentLaunchRuntime,
  repoId: string
): Promise<RepoWorkspace> {
  const repo = runtime.requireStore().getRepo(repoId)
  if (!repo || repo.path.trim().length === 0) {
    return { ok: false, code: 'workspace-unresolved' }
  }
  if (repo.connectionId != null) {
    return { ok: false, code: 'workspace-remote-unsupported' }
  }
  try {
    // The repo's own root id is scoped to its repo and covers git and folder repos alike.
    const target = await runtime.resolveRuntimeFileTarget(
      `id:${getRepoMainWorktreeId({ id: repoId, path: repo.path })}`
    )
    if (target.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return { ok: false, code: 'workspace-remote-unsupported' }
    }
    if (target.worktree.repoId !== repoId || !target.worktree.id) {
      return { ok: false, code: 'workspace-repo-mismatch' }
    }
    return { ok: true, worktreeId: target.worktree.id }
  } catch (error) {
    const ambiguous =
      error instanceof Error &&
      (error.message === 'selector_ambiguous' ||
        error.message === 'worktree_execution_host_unresolved')
    return { ok: false, code: ambiguous ? 'workspace-ambiguous' : 'workspace-unresolved' }
  }
}
