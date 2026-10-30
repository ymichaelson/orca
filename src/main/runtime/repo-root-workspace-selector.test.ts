import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import type { Store } from '../persistence'
import {
  resolveScopedWorktreeIdRow,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'

function folderRepo(): Repo {
  return {
    id: 'notes',
    path: '/work/notes',
    displayName: 'notes',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder'
  }
}

describe('repo root workspace selector for forge dispatch', () => {
  it('resolves a folder repo by its root id to a row owned by that repo, not a fabricated worktree', async () => {
    const repo = folderRepo()
    const meta: Record<string, WorktreeMeta> = {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store; the resolver reads only these members.
    const store = {
      getRepos: () => [repo],
      getAllWorktreeMeta: () => meta,
      getAllWorktreeLineage: () => ({}),
      getProjects: () => [],
      getSettings: () => ({}),
      setWorktreeMeta: (target: { id: string }, updates: Partial<WorktreeMeta>) => {
        meta[target.id] = mergeWorktreeMetaForWrite(meta[target.id], updates)
        return meta[target.id]
      }
    } as unknown as Store
    const scanRepo = vi.fn<RepoWorktreeRowDeps['scanRepo']>(async () => ({
      ok: true,
      worktrees: []
    }))
    const deps: RepoWorktreeRowDeps = {
      store,
      scanRepo,
      listFolderWorkspaces: (owner, count) => listRuntimeFolderWorkspaces(store, owner, count)
    }

    const row = await resolveScopedWorktreeIdRow(deps, getRepoMainWorktreeId(repo))

    expect(row).toMatchObject({ id: 'notes::/work/notes', repoId: 'notes', path: '/work/notes' })
  })
})
