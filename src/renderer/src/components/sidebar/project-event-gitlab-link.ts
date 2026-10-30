import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** `unknown` means this app has no way to ask that host, so only the host's own binding check can say. */
export type ProjectEventGitlabLink = 'gitlab' | 'not-gitlab' | 'unknown'

/** Asks the main process (glab known hosts) for repos it owns; a paired server's repos cannot be asked from here. */
export async function detectProjectEventGitlabLink(
  repo: Repo,
  target: RuntimeClientTarget | null
): Promise<ProjectEventGitlabLink> {
  if (target === null || target.kind === 'environment') {
    return 'unknown'
  }
  try {
    const ref = await window.api.gl.projectSlug({
      repoPath: repo.path,
      repoId: repo.id,
      repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
    })
    return ref ? 'gitlab' : 'not-gitlab'
  } catch {
    // Why: a failed lookup must not block the add, and settings still offer the setup later.
    return 'not-gitlab'
  }
}
