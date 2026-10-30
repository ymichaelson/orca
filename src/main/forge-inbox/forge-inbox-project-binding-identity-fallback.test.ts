import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

const { gitExecFileAsyncMock, glabExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock,
    glabExecFileAsync: glabExecFileAsyncMock
  }
})

import type { SecretStore } from '../../shared/secret-store'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import { _resetKnownHostsCache } from '../gitlab/gitlab-known-host-probe'
import { _resetProjectRefCache } from '../gitlab/gitlab-project-ref-resolution'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ensureProjectBinding } from './forge-inbox-project-binding-reconcile'
import { fakeGitlab, fakeStore, receiverBaseUrl } from './forge-inbox-project-binding-test-fixture'

const REMOTE_URL = 'https://gitlab.test:8929/group/demo.git'

function mockGitAndGlab(): void {
  glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return { stdout: 'Logged in to gitlab.test:8929 as root\n', stderr: '' }
    }
    throw new Error(`unexpected glab ${args.join(' ')}`)
  })
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === undefined) {
      return { stdout: 'origin\n', stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
      return { stdout: REMOTE_URL, stderr: '' }
    }
    throw new Error(`fatal: No such remote '${args[2] ?? ''}'`)
  })
}

describe('project binding identity fallback', () => {
  let root: string
  let dbPath: string
  let clock: number
  let store: SecretStore
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-fallback-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
    mockGitAndGlab()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves through git and glab when the repo has no stored remote identity', async () => {
    const gitlab = fakeGitlab()

    const result = await ensureProjectBinding(ctx, {
      repoPath: '/repo',
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.binding.gitlabHost).toBe('gitlab.test:8929')
    expect(result.binding.gitlabPath).toBe('group/demo')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(gitlab.calls).toContainEqual(
      expect.objectContaining({
        args: ['api', '-i', '--hostname', 'gitlab.test:8929', 'projects/group%2Fdemo']
      })
    )
  })
})
