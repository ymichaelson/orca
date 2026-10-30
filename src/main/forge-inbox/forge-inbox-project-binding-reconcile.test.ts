import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type { SecretStore } from '../../shared/secret-store'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import { _resetKnownHostsCache, rememberGlabKnownHost } from '../gitlab/gitlab-known-host-probe'
import { _resetProjectRefCache } from '../gitlab/gitlab-project-ref-resolution'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import {
  getProjectBinding,
  listProjectBindings,
  upsertProjectBinding
} from './forge-inbox-project-binding'
import { readProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { ensureProjectBinding, removeProjectBinding } from './forge-inbox-project-binding-reconcile'
import { fakeGitlab, fakeStore, receiverBaseUrl } from './forge-inbox-project-binding-test-fixture'

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

describe('project event binding reconcile', () => {
  let root: string
  let dbPath: string
  let clock: number
  let store: SecretStore
  let ctx: ForgeLedgerContext

  const open = (): ForgeLedgerContext => {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => store
    }
  }

  type EnsureExtra = Partial<Parameters<typeof ensureProjectBinding>[1]> & {
    repoId?: string
    probe?: (input: {
      bindingId: string
      callbackUrl: string
    }) => Promise<{ ok: boolean; code?: string }>
  }

  const ensure = (gitlab: ReturnType<typeof fakeGitlab>, extra: EnsureExtra = {}) =>
    ensureProjectBinding(ctx, {
      repoPath: '/repo',
      explicitProjectRef: { host: gitlab.host, path: 'group/demo' },
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true }),
      ...extra
    })

  const linkRows = () =>
    ctx.db
      .prepare('SELECT repo_id, binding_id FROM project_event_repo_links ORDER BY repo_id')
      .all()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-reconcile-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    store = fakeStore()
    ctx = open()
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('registers a hook, records its id and seals the secret without leaking it', async () => {
    const gitlab = fakeGitlab()
    const result = await ensure(gitlab)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.binding.state).toBe('connected')
    expect(result.binding.hookId).toBe(1)
    expect(result.binding.gitlabHost).toBe(gitlab.host)
    expect(result.binding.gitlabPath).toBe('group/demo')
    expect(result.binding.gitlabProjectId).toBe(3)
    expect(result.binding.callbackUrl).toBe(
      `https://orca.example.com/webhooks/gitlab/${result.binding.bindingId}`
    )
    expect(result.events).toEqual({
      enabledEvents: expect.arrayContaining(['push_events', 'merge_requests_events']),
      unsupportedEvents: [],
      rejectedEvents: []
    })

    expect(gitlab.hooks).toHaveLength(1)
    expect(gitlab.hooks[0].url).toBe(result.binding.callbackUrl)

    const revealed = readProjectBindingSecret(ctx, result.binding.bindingId)
    expect(revealed?.protection).toBe('sealed')
    expect(revealed?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(gitlab.created[0].body.token).toBe(revealed?.secret)
    expect(JSON.stringify(result.binding)).not.toContain(revealed?.secret ?? '')
  })

  it('reports a non-GitLab remote as not-gitlab without calling the GitLab API', async () => {
    const glabCalls: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === undefined) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: 'https://gitea.example/team/api.git', stderr: '' }
      }
      throw new Error(`fatal: No such remote '${args[2] ?? ''}'`)
    })
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      glabCalls.push(args)
      if (args[0] === 'auth' && args[1] === 'status' && args[2] === undefined) {
        return { stdout: 'Logged in to gitlab.test:8929 as root\n', stderr: '' }
      }
      throw new Error(`unexpected glab ${args.join(' ')}`)
    })
    const gitlab = fakeGitlab()

    const result = await ensureProjectBinding(ctx, {
      repoPath: '/repo',
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })

    expect(result).toEqual({
      ok: false,
      binding: null,
      code: 'not-gitlab',
      retryable: false
    })
    expect(glabCalls.filter((args) => args.includes('api'))).toEqual([])
    expect(gitlab.calls).toEqual([])
  })

  it('reuses the binding and hook on a second ensure, keeping the same secret', async () => {
    const gitlab = fakeGitlab()
    const first = await ensure(gitlab)
    expect(first.ok).toBe(true)

    const second = await ensure(gitlab)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }

    expect(second.binding.bindingId).toBe(first.binding.bindingId)
    expect(second.binding.hookId).toBe(first.binding.hookId)
    expect(gitlab.hooks).toHaveLength(1)
    expect(gitlab.created).toHaveLength(2)
    expect(gitlab.created[0].method).toBe('POST')
    expect(gitlab.created[1].method).toBe('PUT')
    expect(gitlab.created[1].body.token).toBe(gitlab.created[0].body.token)
    expect(second.binding.secretProtection).toBe('sealed')
  })

  it('reports a pre-binding identity failure without creating a binding row', async () => {
    const gitlab = fakeGitlab({ projectStatus: 401 })
    const result = await ensure(gitlab)

    expect(result).toEqual({ ok: false, binding: null, code: 'unauthenticated', retryable: true })
    expect(gitlab.hooks).toHaveLength(0)
  })

  it('persists a hook-permission failure against the binding', async () => {
    const gitlab = fakeGitlab({ permissionStatus: 403 })
    const result = await ensure(gitlab)

    expect(result.ok).toBe(false)
    if (result.ok || result.binding === null) {
      return
    }
    expect(result.binding.state).toBe('failed')
    expect(result.binding.failure).toEqual({
      phase: 'checking',
      code: 'no-hook-permission',
      failedAt: expect.any(Number),
      retryable: true
    })
    expect(gitlab.hooks).toHaveLength(0)
  })

  it('fails visibly when the host cannot seal the secret without permission', async () => {
    store = fakeStore({
      isEncryptionAvailable: () => false,
      describeProtectionGap: () => 'no keychain on this host'
    })
    const gitlab = fakeGitlab()
    const result = await ensure(gitlab)

    expect(result.ok).toBe(false)
    if (result.ok || result.binding === null) {
      return
    }
    expect(result.binding.failure).toMatchObject({
      phase: 'registering',
      code: 'unprotected-storage',
      retryable: true
    })
    expect(gitlab.created).toHaveLength(0)
  })

  it('records an unknown-outcome when the hook write fails after being attempted', async () => {
    const gitlab = fakeGitlab({ failCreate: true })
    const result = await ensure(gitlab)

    expect(result.ok).toBe(false)
    if (result.ok || result.binding === null) {
      return
    }
    expect(result.binding.state).toBe('failed')
    expect(result.binding.failure).toMatchObject({
      phase: 'registering',
      code: 'unknown-outcome',
      retryable: true
    })
  })

  it('keeps a partially rejected registration out of connected and retains the rejection', async () => {
    const gitlab = fakeGitlab({ rejectEvents: ['releases_events'] })
    const result = await ensure(gitlab)

    expect(result.ok).toBe(false)
    if (result.ok || result.binding === null) {
      return
    }
    expect(result.code).toBe('event-configuration-rejected')
    expect(result.binding.state).toBe('failed')
    expect(result.binding.failure).toEqual({
      phase: 'verifying',
      code: 'event-configuration-rejected',
      failedAt: expect.any(Number),
      retryable: false
    })
    expect(result.binding.hookId).toBe(1)
    expect(result.binding.rejectedEvents).toEqual(['releases_events'])
    expect(result.events.rejectedEvents).toEqual(['releases_events'])
    // Why: the accepted flags still deliver, so the caller must be able to show exactly those.
    expect(result.events.enabledEvents).toEqual(
      Object.entries(gitlab.hooks[0])
        .filter(([flag, enabled]) => flag.endsWith('_events') && enabled === true)
        .map(([flag]) => flag)
    )
    expect(result.events.unsupportedEvents).toEqual([])
    expect(getProjectBinding(ctx, result.binding.bindingId)?.rejectedEvents).toEqual([
      'releases_events'
    ])
    // The accepted flags still deliver, so the hook must not be deleted.
    expect(gitlab.deleted).toEqual([])
    expect(gitlab.hooks).toHaveLength(1)
    expect(listProjectBindings(ctx).map((binding) => binding.state)).not.toContain('verifying')
  })

  it('keeps the existing binding path when another worktree of the repo reconciles', async () => {
    const gitlab = fakeGitlab()
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo-main',
      gitlabHost: gitlab.host,
      gitlabPath: 'group/demo',
      gitlabProjectId: gitlab.projectId,
      callbackUrl: `${receiverBaseUrl}/webhooks/gitlab/${bindingId}`
    })

    const result = await ensure(gitlab, { repoPath: '/repo-worktree' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.binding.bindingId).toBe(bindingId)
    expect(result.binding.projectPath).toBe('/repo-main')
    expect(getProjectBinding(ctx, bindingId)?.projectPath).toBe('/repo-main')
  })

  it('publishes checking, registering and verifying before connected', async () => {
    const gitlab = fakeGitlab()
    const observed: Record<string, unknown> = {}
    const probeCalls: { bindingId: string; callbackUrl: string }[] = []

    const result = await ensure(gitlab, {
      probe: async (input) => {
        probeCalls.push(input)
        observed.probeState = listProjectBindings(ctx)[0]?.state
        observed.probeHookId = listProjectBindings(ctx)[0]?.hookId
        return { ok: true }
      },
      exec: async (args, options) => {
        const resource = args.find((arg) => arg.startsWith('projects/')) ?? ''
        if (resource.endsWith('hooks?per_page=1')) {
          observed.permissionState = listProjectBindings(ctx)[0]?.state
        }
        if (resource.includes('/hooks') && !resource.endsWith('hooks?per_page=1')) {
          observed.registerState = listProjectBindings(ctx)[0]?.state
        }
        return gitlab.exec(args, options)
      }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(observed.permissionState).toBe('checking')
    expect(observed.registerState).toBe('registering')
    expect(observed.probeState).toBe('verifying')
    expect(observed.probeHookId).toBe(1)
    expect(result.binding.state).toBe('connected')
    expect(listProjectBindings(ctx).map((binding) => binding.state)).not.toContain('verifying')
    expect(probeCalls).toEqual([
      {
        bindingId: result.binding.bindingId,
        callbackUrl: result.binding.callbackUrl
      }
    ])
  })

  it('fails in verifying when the loopback probe fails and reuses the hook on retry', async () => {
    const gitlab = fakeGitlab()

    const first = await ensure(gitlab, {
      repoId: 'repo-1',
      probe: async () => ({ ok: false, code: 'probe-refused' })
    })
    expect(first.ok).toBe(false)
    if (first.ok || first.binding === null) {
      return
    }
    expect(first.binding.state).toBe('failed')
    expect(first.binding.failure).toMatchObject({
      phase: 'verifying',
      code: 'probe-refused',
      retryable: true
    })
    expect(first.binding.hookId).toBe(1)

    const second = await ensure(gitlab, {
      repoId: 'repo-1',
      probe: async () => ({ ok: true })
    })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.binding.state).toBe('connected')
    expect(second.binding.hookId).toBe(1)
    expect(gitlab.hooks).toHaveLength(1)
    expect(gitlab.created.map((entry) => entry.method)).toEqual(['POST', 'PUT'])
    expect(listProjectBindings(ctx).map((binding) => binding.state)).not.toContain('verifying')
  })

  it('keeps a healthy binding untouched when a second clone of the same project conflicts', async () => {
    const gitlab = fakeGitlab()
    const first = await ensure(gitlab, { repoId: 'repo-a', repoPath: '/clone-a' })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const bindingRow = () =>
      ctx.db
        .prepare('SELECT * FROM project_bindings WHERE binding_id = ?')
        .get(first.binding.bindingId)
    const before = bindingRow()
    const callsBefore = gitlab.calls.length

    const second = await ensure(gitlab, { repoId: 'repo-b', repoPath: '/clone-b' })

    expect(second).toMatchObject({
      ok: false,
      binding: null,
      code: 'binding-conflict',
      retryable: false
    })
    expect(bindingRow()).toEqual(before)
    expect(getProjectBinding(ctx, first.binding.bindingId)).toMatchObject({
      state: 'connected',
      projectPath: '/clone-a'
    })
    expect(listProjectBindings(ctx)).toHaveLength(1)
    expect(linkRows()).toEqual([{ repo_id: 'repo-a', binding_id: first.binding.bindingId }])
    expect(gitlab.created).toHaveLength(1)
    expect(gitlab.calls.slice(callsBefore).every((call) => call.method === 'GET')).toBe(true)
  })

  it('refuses a repo already linked to another project without creating a binding for it', async () => {
    const gitlab = fakeGitlab()
    const first = await ensure(gitlab, { repoId: 'repo-a' })
    expect(first.ok).toBe(true)
    const other = fakeGitlab({ projectId: 9 })

    const moved = await ensure(other, {
      repoId: 'repo-a',
      explicitProjectRef: { host: other.host, path: 'group/other' }
    })

    expect(moved).toMatchObject({ ok: false, binding: null, code: 'binding-conflict' })
    expect(listProjectBindings(ctx)).toHaveLength(1)
    expect(other.created).toHaveLength(0)
  })

  it('removes a hook whose creation response was lost before its id was recorded', async () => {
    const gitlab = fakeGitlab()
    let dropped = false
    const lossy: typeof gitlab.exec = async (args, options) => {
      const response = await gitlab.exec(args, options)
      if (!dropped && args.includes('POST') && args.some((arg) => arg.endsWith('/hooks'))) {
        dropped = true
        throw new Error('response lost')
      }
      return response
    }
    const first = await ensure(gitlab, { exec: lossy })
    expect(first.ok).toBe(false)
    expect(gitlab.hooks).toHaveLength(1)
    const bindingId = listProjectBindings(ctx)[0].bindingId
    expect(getProjectBinding(ctx, bindingId)?.hookId).toBeNull()

    const removed = await removeProjectBinding(ctx, { bindingId, exec: gitlab.exec })

    expect(removed.ok).toBe(true)
    expect(gitlab.hooks).toHaveLength(0)
  })

  it('runs one reconcile for concurrent worktrees of the same repo', async () => {
    let releasePermission: () => void = () => undefined
    const permissionGate = new Promise<void>((resolve) => (releasePermission = resolve))
    let permissionCalls = 0
    const gitlab = fakeGitlab({
      onCall: async ({ resource }) => {
        if (resource.endsWith('hooks?per_page=1')) {
          permissionCalls += 1
          await permissionGate
        }
      }
    })

    const first = ensure(gitlab, { repoId: 'repo-1', repoPath: '/repo-a' })
    const second = ensure(gitlab, { repoId: 'repo-1', repoPath: '/repo-b' })
    await Promise.resolve()
    releasePermission()
    const [a, b] = await Promise.all([first, second])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) {
      return
    }
    expect(a.binding.bindingId).toBe(b.binding.bindingId)
    expect(gitlab.hooks).toHaveLength(1)
    expect(gitlab.created).toHaveLength(1)
    expect(gitlab.created[0].method).toBe('POST')
    expect(listProjectBindings(ctx)).toHaveLength(1)
    expect(linkRows()).toEqual([{ repo_id: 'repo-1', binding_id: a.binding.bindingId }])
  })

  it('runs hook calls with the remote execution context instead of a local cwd', async () => {
    const remote = fakeGitlab()
    const remoteResult = await ensure(remote, { repoId: 'repo-1', connectionId: 'remote-1' })
    expect(remoteResult.ok).toBe(true)

    const remoteWrites = remote.calls.filter(
      (call) => call.method !== 'GET' && call.resource.includes('/hooks')
    )
    expect(remoteWrites.length).toBeGreaterThan(0)
    for (const call of remoteWrites) {
      expect(call.options?.cwd).toBeUndefined()
      expect(call.args).toEqual(
        expect.arrayContaining([
          '--hostname',
          remote.host,
          expect.stringContaining(`projects/${remote.projectId}/hooks`)
        ])
      )
    }

    const local = fakeGitlab({ projectId: 4 })
    const localResult = await ensure(local, { repoId: 'repo-2' })
    expect(localResult.ok).toBe(true)
    const localWrites = local.calls.filter(
      (call) => call.method !== 'GET' && call.resource.includes('/hooks')
    )
    expect(localWrites.length).toBeGreaterThan(0)
    for (const call of localWrites) {
      expect(call.options?.cwd).toBe('/repo')
    }
  })

  it('removes only the owned hook and this repo link when a project is deleted', async () => {
    const gitlab = fakeGitlab()
    const ensured = await ensure(gitlab, { repoId: 'repo-1' })
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) {
      return
    }
    gitlab.hooks.push({
      id: 99,
      project_id: gitlab.projectId,
      url: 'https://other.example/hook',
      name: 'Another integration',
      description: 'not-orca'
    })

    const removed = await removeProjectBinding(ctx, {
      bindingId: ensured.binding.bindingId,
      exec: gitlab.exec
    })

    expect(removed).toEqual({
      ok: true,
      bindingId: ensured.binding.bindingId,
      removedHook: true
    })
    expect(gitlab.hooks.map((hook) => hook.id)).toEqual([99])
    expect(getProjectBinding(ctx, ensured.binding.bindingId)).toBeNull()
    expect(linkRows()).toEqual([])
  })

  it('removes the remote hook then the local binding', async () => {
    const gitlab = fakeGitlab()
    const ensured = await ensure(gitlab)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) {
      return
    }

    const removed = await removeProjectBinding(ctx, {
      bindingId: ensured.binding.bindingId,
      exec: gitlab.exec
    })
    expect(removed).toEqual({ ok: true, bindingId: ensured.binding.bindingId, removedHook: true })
    expect(gitlab.hooks).toHaveLength(0)
    expect(getProjectBinding(ctx, ensured.binding.bindingId)).toBeNull()
  })

  it('treats removing an unknown binding as idempotent success', async () => {
    const gitlab = fakeGitlab()
    const result = await removeProjectBinding(ctx, {
      bindingId: '00000000-0000-4000-8000-000000000000',
      exec: gitlab.exec
    })
    expect(result).toEqual({
      ok: true,
      bindingId: '00000000-0000-4000-8000-000000000000',
      removedHook: false
    })
    expect(gitlab.deleted).toHaveLength(0)
  })

  it('binds a folder from the explicit project text instead of reading a local remote', async () => {
    const gitlab = fakeGitlab()
    rememberGlabKnownHost(gitlab.host)

    const result = await ensureProjectBinding(ctx, {
      repoPath: '/notes',
      explicitProjectRefText: `https://${gitlab.host}/group/demo`,
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.binding.gitlabHost).toBe(gitlab.host)
    expect(result.binding.gitlabPath).toBe('group/demo')
    expect(result.binding.gitlabProjectId).toBe(3)
    expect(gitlab.calls.map((call) => call.resource)).toContain('projects/group%2Fdemo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects unreadable explicit text before creating any binding or hook', async () => {
    const gitlab = fakeGitlab()
    rememberGlabKnownHost(gitlab.host)

    const result = await ensureProjectBinding(ctx, {
      repoPath: '/notes',
      explicitProjectRefText: 'not a url',
      receiverBaseUrl,
      exec: gitlab.exec,
      probe: async () => ({ ok: true })
    })

    expect(result).toEqual({ ok: false, binding: null, code: 'not-gitlab', retryable: false })
    expect(listProjectBindings(ctx)).toHaveLength(0)
    expect(gitlab.calls).toHaveLength(0)
  })
})
