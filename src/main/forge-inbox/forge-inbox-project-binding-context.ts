import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'

export type ProjectBindingContextStore = {
  getRepo: (id: string) => Repo | undefined
  getFolderWorkspace?: (id: string) => FolderWorkspace | undefined
}

export type ProjectBindingContext =
  | {
      ok: true
      repoPath: string
      connectionId: string | null
      source: 'repo'
      /** User-typed project reference for a folder; null when the repo must resolve from its remote. */
      explicitProjectRefText: string | null
    }
  | { ok: false; code: 'repo-not-found' | 'no-git-remote' | 'remote-host-repo'; retryable: false }

/**
 * Resolves a repository id to the path and connection for glab. The client never supplies a path:
 * a folder workspace has no proven Git root, so it is refused rather than treated as a worktree.
 */
export function resolveProjectBindingContext(
  store: ProjectBindingContextStore,
  repoId: string
): ProjectBindingContext {
  const repo = store.getRepo(repoId)
  if (repo) {
    // A remote host owns this repo; binding it here would point that hook at the wrong receiver.
    if (repo.connectionId != null) {
      return { ok: false, code: 'remote-host-repo', retryable: false }
    }
    const connectionId = repo.connectionId ?? null
    if (repo.kind === 'folder') {
      const explicitProjectRefText = repo.projectEventGitlabProject ?? null
      if (explicitProjectRefText !== null) {
        // Why: a folder has no remote to infer a project from, so only the user's explicit text can
        // name one — and the host still verifies it through the GitLab API.
        const repoPath = repo.path.trim()
        return repoPath.length === 0
          ? { ok: false, code: 'no-git-remote', retryable: false }
          : { ok: true, repoPath, connectionId, source: 'repo', explicitProjectRefText }
      }
      const repoPath = repo.folderUpgradeGitRootPath ?? ''
      return repoPath.length === 0
        ? { ok: false, code: 'no-git-remote', retryable: false }
        : { ok: true, repoPath, connectionId, source: 'repo', explicitProjectRefText: null }
    }
    // Why ignore it for git repos: the remote is authoritative, so a stale explicit text must not
    // silently bind the hook to a different GitLab project than the one this checkout pushes to.
    const repoPath = repo.path.trim()
    return repoPath.length === 0
      ? { ok: false, code: 'no-git-remote', retryable: false }
      : { ok: true, repoPath, connectionId, source: 'repo', explicitProjectRefText: null }
  }
  if (store.getFolderWorkspace?.(repoId)) {
    return { ok: false, code: 'no-git-remote', retryable: false }
  }
  return { ok: false, code: 'repo-not-found', retryable: false }
}
