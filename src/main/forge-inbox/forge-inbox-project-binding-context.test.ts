import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import { resolveProjectBindingContext } from './forge-inbox-project-binding-context'
import { forgeInboxProjectBindingContextForRuntime } from './forge-inbox-project-binding-runtime'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/work/repo',
    displayName: 'repo',
    badgeColor: '#ffffff',
    addedAt: 1,
    ...overrides
  }
}

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'notes',
    folderPath: '/work/notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('project binding context resolution', () => {
  it('resolves a local repository path from the runtime store', () => {
    const store = { getRepo: (id: string) => (id === 'repo-1' ? repo() : undefined) }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: true,
      repoPath: '/work/repo',
      connectionId: null,
      source: 'repo',
      explicitProjectRefText: null
    })
  })

  it('refuses a repository owned by another host instead of trusting its local path', () => {
    const store = {
      getRepo: () => repo({ connectionId: 'remote-1', executionHostId: 'runtime:remote-1' })
    }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: false,
      code: 'remote-host-repo',
      retryable: false
    })
  })

  it('refuses a remote-host repository before inspecting its path', () => {
    const store = { getRepo: () => repo({ connectionId: 'remote-1', path: '' }) }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: false,
      code: 'remote-host-repo',
      retryable: false
    })
  })

  it('reports an unknown repository explicitly instead of guessing a path', () => {
    const store = { getRepo: () => undefined }

    expect(resolveProjectBindingContext(store, 'missing')).toEqual({
      ok: false,
      code: 'repo-not-found',
      retryable: false
    })
  })

  it('refuses a folder-only repository that has no proven Git root', () => {
    const store = { getRepo: () => repo({ kind: 'folder' }) }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: false,
      code: 'no-git-remote',
      retryable: false
    })
  })

  it('uses the Git root proven when a folder repository was upgraded', () => {
    const store = {
      getRepo: () => repo({ kind: 'folder', folderUpgradeGitRootPath: '/work/repo-git-root' })
    }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: true,
      repoPath: '/work/repo-git-root',
      connectionId: null,
      source: 'repo',
      explicitProjectRefText: null
    })
  })

  it('binds a folder from the explicit project the user typed', () => {
    const store = {
      getRepo: () =>
        repo({ kind: 'folder', path: '/work/notes', projectEventGitlabProject: 'group/demo' })
    }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: true,
      repoPath: '/work/notes',
      connectionId: null,
      source: 'repo',
      explicitProjectRefText: 'group/demo'
    })
  })

  it('ignores the explicit project text on a git repository, where the remote is authoritative', () => {
    const store = {
      getRepo: () => repo({ kind: 'git', projectEventGitlabProject: 'group/other' })
    }

    expect(resolveProjectBindingContext(store, 'repo-1')).toEqual({
      ok: true,
      repoPath: '/work/repo',
      connectionId: null,
      source: 'repo',
      explicitProjectRefText: null
    })
  })

  it('refuses a folder workspace without inventing a Git worktree', () => {
    const store = {
      getRepo: () => undefined,
      getFolderWorkspace: () => folderWorkspace({ connectionId: 'remote-1' })
    }

    expect(resolveProjectBindingContext(store, 'folder-1')).toEqual({
      ok: false,
      code: 'no-git-remote',
      retryable: false
    })
  })

  it('still resolves a repository when the runtime store has no folder accessor', () => {
    const store = { getRepo: (id: string) => (id === 'repo-1' ? repo() : undefined) }

    expect(resolveProjectBindingContext(store, 'repo-1').ok).toBe(true)
    expect(resolveProjectBindingContext(store, 'folder-1')).toEqual({
      ok: false,
      code: 'repo-not-found',
      retryable: false
    })
  })

  it('builds the production resolver from the runtime store', () => {
    const resolver = forgeInboxProjectBindingContextForRuntime({
      requireStore: () => ({
        getRepo: (id: string) => (id === 'repo-1' ? repo() : undefined)
      })
    })

    expect(resolver('repo-1')).toEqual({
      ok: true,
      repoPath: '/work/repo',
      connectionId: null,
      source: 'repo',
      explicitProjectRefText: null
    })
  })
})
