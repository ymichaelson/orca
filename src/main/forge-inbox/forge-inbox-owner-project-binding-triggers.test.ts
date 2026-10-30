import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import { _resetKnownHostsCache } from '../gitlab/gitlab-known-host-probe'
import { _resetProjectRefCache } from '../gitlab/gitlab-project-ref-resolution'
import { createReceiverSettingsFixture } from '../project-events/project-event-receiver-settings-test-fixture'
import type { Repo } from '../../shared/repo-types'
import { fakeGitlab, fakeStore } from './forge-inbox-project-binding-test-fixture'
import { resolveProjectBindingContext } from './forge-inbox-project-binding-context'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { authorizeProjectEventBinding } from './forge-inbox-project-event-binding-auth'
import { createForgeInboxOwnerService } from './forge-inbox-owner-service'

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

const REMOTE_URL = 'https://gitlab.test:8929/group/demo.git'

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('project event binding reconcile triggers', () => {
  let root: string | undefined
  let service: ReturnType<typeof createForgeInboxOwnerService> | undefined

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === undefined) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: REMOTE_URL, stderr: '' }
      }
      throw new Error(`fatal: No such remote '${args[2] ?? ''}'`)
    })
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth' && args[1] === 'status' && args[2] === undefined) {
        return { stdout: 'Logged in to gitlab.test:8929 as root\n', stderr: '' }
      }
      throw new Error(`unexpected glab ${args.join(' ')}`)
    })
  })

  afterEach(async () => {
    await service?.stop()
    service = undefined
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  function seedEnabledPolicy(dbPath: string, secretStore: ReturnType<typeof fakeStore>): void {
    const ledger = ForgeInboxLedger.open(dbPath, { hostId: 'host-1', secretStore })
    try {
      const saved = ledger.updateProjectEventPolicy('repo-1', 0, { enabled: true })
      expect(saved.ok).toBe(true)
    } finally {
      ledger.close()
    }
  }

  function createService(
    dbPath: string,
    gitlab: ReturnType<typeof fakeGitlab>,
    receiverSettings: ReturnType<typeof createReceiverSettingsFixture>,
    exec: typeof gitlab.exec = gitlab.exec,
    probe: () => Promise<{ ok: boolean }> = async () => ({ ok: true }),
    secretStore = fakeStore()
  ) {
    return createForgeInboxOwnerService({
      dbPath,
      hostId: 'host-1',
      http: { fetch: () => Promise.reject(new Error('no network in tests')) },
      receiverSettings,
      resolveProjectBindingContext: () => ({
        ok: true,
        repoPath: '/repo',
        connectionId: null,
        source: 'repo',
        explicitProjectRefText: null
      }),
      projectBindingExec: exec,
      probeProjectEventBinding: probe,
      secretStore
    })
  }

  function createServiceForRepo(
    dbPath: string,
    repo: Repo,
    gitlab: ReturnType<typeof fakeGitlab>,
    receiverSettings: ReturnType<typeof createReceiverSettingsFixture>
  ) {
    return createForgeInboxOwnerService({
      dbPath,
      hostId: 'host-1',
      http: { fetch: () => Promise.reject(new Error('no network in tests')) },
      secretStore: fakeStore(),
      receiverSettings,
      resolveProjectBindingContext: (repoId) =>
        resolveProjectBindingContext({ getRepo: () => repo }, repoId),
      projectBindingExec: gitlab.exec,
      probeProjectEventBinding: async () => ({ ok: true })
    })
  }

  function repo(overrides: Partial<Repo> = {}): Repo {
    return {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#ffffff',
      addedAt: 1,
      ...overrides
    }
  }

  it('reconciles an enabled repository policy when the owner starts', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-start-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    service = createService(dbPath, gitlab, receiverSettings)

    await service.start()

    await waitFor(() => gitlab.hooks.length === 1, 'the start-triggered hook')
    expect(gitlab.hooks[0].url).toContain('/webhooks/gitlab/')
    expect(gitlab.hooks[0].description).toMatch(/^orca-project-event-binding:/)
  })

  it('answers empty activity without opening a ledger for a never-started owner', () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-dormant-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    service = createService(dbPath, fakeGitlab(), createReceiverSettingsFixture())

    expect(service.getProjectEventActivity('repo-1')).toEqual({
      events: [],
      lastProcessed: null
    })
    expect(existsSync(dbPath)).toBe(false)
  })

  it('serializes rotation with reconciliation for the same repository', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-serialize-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    let inFlight = 0
    const gatedExec: typeof gitlab.exec = async (...args) => {
      if (inFlight > 0) {
        throw new Error('overlapping GitLab writes for one repository')
      }
      inFlight += 1
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await gitlab.exec(...args)
      } finally {
        inFlight -= 1
      }
    }
    service = createService(dbPath, gitlab, receiverSettings, gatedExec)

    await service.start()
    await waitFor(
      () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
      'the connected binding'
    )

    const [retried, rotated] = await Promise.all([
      service.retryProjectEvent('repo-1'),
      service.rotateProjectEventSecret('repo-1')
    ])

    expect(retried.ok).toBe(true)
    expect(rotated.ok).toBe(true)
  })

  it('re-registers the callback URL when the receiver settings change', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-receiver-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    service = createService(dbPath, gitlab, receiverSettings)

    await service.start()
    await waitFor(() => gitlab.hooks.length === 1, 'the initial hook')
    expect(gitlab.hooks[0].url).toMatch(/^https:\/\/orca\.example\.com\//)

    receiverSettings.update({ externalBaseUrl: 'https://orca-2.example.com' })

    await waitFor(
      () => gitlab.hooks[0]?.url?.startsWith('https://orca-2.example.com/') === true,
      'the updated callback URL'
    )
    expect(gitlab.created.filter((entry) => entry.method === 'PUT').length).toBeGreaterThan(0)
  })

  it('refuses a folder workspace with no explicit project without calling glab', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-folder-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    service = createServiceForRepo(
      dbPath,
      repo({ kind: 'folder' }),
      gitlab,
      createReceiverSettingsFixture()
    )
    await service.start()

    const result = await service.retryProjectEvent('repo-1')

    expect(result).toEqual({ ok: false, binding: null, code: 'no-git-remote', retryable: false })
    expect(gitlab.calls).toHaveLength(0)
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('binds a git repository from its remote even when explicit project text is set', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-git-remote-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    service = createServiceForRepo(
      dbPath,
      repo({ kind: 'git', projectEventGitlabProject: 'other/explicit' }),
      gitlab,
      receiverSettings
    )

    await service.start()
    await waitFor(
      () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
      'the remote-derived binding'
    )

    expect(service.getProjectEventBinding('repo-1')?.gitlabPath).toBe('group/demo')
    expect(gitlab.calls.map((call) => call.resource)).not.toContain('projects/other%2Fexplicit')
  })

  it('re-applies a staged rotation secret when the owner opens again', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-rotation-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    let drop = false
    const lossy: typeof gitlab.exec = async (args, options) => {
      const response = await gitlab.exec(args, options)
      if (drop && args.includes('PUT')) {
        drop = false
        throw new Error('response lost')
      }
      return response
    }
    service = createService(dbPath, gitlab, receiverSettings, lossy)
    await service.start()
    await waitFor(
      () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
      'the connected binding'
    )
    drop = true
    const rotated = await service.rotateProjectEventSecret('repo-1')
    expect(rotated.ok).toBe(false)
    expect(service.getProjectEventBinding('repo-1')?.rotationPending).toBe(true)
    const applied = gitlab.hooks[0].token
    await service.stop()

    service = createService(dbPath, gitlab, receiverSettings)
    await service.start()

    await waitFor(
      () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
      'the reconciled binding'
    )
    expect(service.getProjectEventBinding('repo-1')?.rotationPending).toBe(false)
    expect(gitlab.hooks[0].token).toBe(applied)
  })

  it('retries a lost-response rotation after a bounded delay', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-rotation-retry-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    seedEnabledPolicy(dbPath, fakeStore())
    let drop = false
    const lossy: typeof gitlab.exec = async (args, options) => {
      const response = await gitlab.exec(args, options)
      if (drop && args.includes('PUT')) {
        drop = false
        throw new Error('response lost')
      }
      return response
    }
    service = createService(dbPath, gitlab, receiverSettings, lossy)
    await service.start()
    await waitFor(
      () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
      'the connected binding'
    )
    drop = true
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await service.rotateProjectEventSecret('repo-1')
      expect(service.getProjectEventBinding('repo-1')?.state).toBe('failed')

      await vi.advanceTimersByTimeAsync(30_000)
      for (
        let i = 0;
        i < 50 && service.getProjectEventBinding('repo-1')?.state !== 'connected';
        i++
      ) {
        await Promise.resolve()
      }

      expect(service.getProjectEventBinding('repo-1')).toMatchObject({
        state: 'connected',
        rotationPending: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('retrying a retained rotation secret', () => {
    type Mode = 'ok' | 'drop-put' | 'down'

    async function lostRotationService() {
      root = mkdtempSync(join(tmpdir(), 'forge-trigger-rotation-chain-'))
      const dbPath = join(root, 'forge-inbox.sqlite')
      const gitlab = fakeGitlab()
      const receiverSettings = createReceiverSettingsFixture()
      receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
      seedEnabledPolicy(dbPath, fakeStore())
      const control: { mode: Mode; calls: number; storageAvailable: boolean } = {
        mode: 'ok',
        calls: 0,
        storageAvailable: true
      }
      const exec: typeof gitlab.exec = async (args, options) => {
        control.calls += 1
        if (control.mode === 'down') {
          throw new Error('network down')
        }
        const response = await gitlab.exec(args, options)
        if (control.mode === 'drop-put' && args.includes('PUT')) {
          control.mode = 'ok'
          throw new Error('response lost')
        }
        return response
      }
      const started = createService(
        dbPath,
        gitlab,
        receiverSettings,
        exec,
        async () => ({ ok: true }),
        fakeStore({ isEncryptionAvailable: () => control.storageAvailable })
      )
      service = started
      await started.start()
      await waitFor(
        () => started.getProjectEventBinding('repo-1')?.state === 'connected',
        'the connected binding'
      )
      control.mode = 'drop-put'
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const lost = await started.rotateProjectEventSecret('repo-1')
      expect(lost).toMatchObject({ ok: false, code: 'unknown-outcome' })
      expect(started.getProjectEventBinding('repo-1')?.rotationPending).toBe(true)
      return { started, control }
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps retrying across a transient failure while the candidate is retained', async () => {
      const { started, control } = await lostRotationService()
      control.mode = 'down'

      await vi.advanceTimersByTimeAsync(30_000)

      expect(started.getProjectEventBinding('repo-1')).toMatchObject({
        state: 'failed',
        rotationPending: true
      })
      control.mode = 'ok'
      await vi.advanceTimersByTimeAsync(120_000)

      expect(started.getProjectEventBinding('repo-1')).toMatchObject({
        state: 'connected',
        rotationPending: false
      })
    })

    it('gives up after the bounded delays and never retries again on its own', async () => {
      const { started, control } = await lostRotationService()
      control.mode = 'down'

      await vi.advanceTimersByTimeAsync(30_000)
      const afterFirst = control.calls
      await vi.advanceTimersByTimeAsync(120_000)
      const afterSecond = control.calls
      control.mode = 'ok'
      await vi.advanceTimersByTimeAsync(3_600_000)

      expect(afterSecond).toBeGreaterThan(afterFirst)
      expect(control.calls).toBe(afterSecond)
      expect(started.getProjectEventBinding('repo-1')).toMatchObject({
        state: 'failed',
        rotationPending: true
      })
    })

    it('keeps only one pending retry per repository after repeated lost responses', async () => {
      const { started, control } = await lostRotationService()
      control.mode = 'drop-put'
      expect(await started.rotateProjectEventSecret('repo-1')).toMatchObject({
        ok: false,
        code: 'unknown-outcome'
      })
      control.mode = 'down'
      const before = control.calls

      await vi.advanceTimersByTimeAsync(30_000)

      expect(control.calls).toBe(before + 1)
      expect(started.getProjectEventBinding('repo-1')?.rotationPending).toBe(true)
    })

    it('cancels the pending retry when the owner stops', async () => {
      const { started, control } = await lostRotationService()
      await started.stop()
      service = undefined
      const afterStop = control.calls
      control.mode = 'ok'

      await vi.advanceTimersByTimeAsync(3_600_000)

      expect(control.calls).toBe(afterStop)
    })

    it.each(['network', 'secret-unavailable'] as const)(
      'arms a fresh bounded chain when a user rotation returns %s with the candidate retained',
      async (code) => {
        const { started, control } = await lostRotationService()
        control.mode = 'down'
        await vi.advanceTimersByTimeAsync(150_000)
        expect(started.getProjectEventBinding('repo-1')?.state).toBe('failed')
        if (code === 'secret-unavailable') {
          control.mode = 'ok'
          control.storageAvailable = false
        }

        const rotated = await started.rotateProjectEventSecret('repo-1')

        expect(rotated).toMatchObject({ ok: false, code, retryable: true })
        expect(started.getProjectEventBinding('repo-1')?.rotationPending).toBe(true)
        control.mode = 'ok'
        control.storageAvailable = true
        await vi.advanceTimersByTimeAsync(30_000)

        expect(started.getProjectEventBinding('repo-1')).toMatchObject({
          state: 'connected',
          rotationPending: false
        })
      }
    )
  })

  it('revalidates a failed setup after rotation before admitting callbacks', async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-trigger-rotation-probe-'))
    const dbPath = join(root, 'forge-inbox.sqlite')
    const gitlab = fakeGitlab()
    const receiverSettings = createReceiverSettingsFixture()
    receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
    let drop = false
    let probeOk = false
    let probes = 0
    service = createService(
      dbPath,
      gitlab,
      receiverSettings,
      async (args, options) => {
        const response = await gitlab.exec(args, options)
        if (drop && args.includes('PUT')) {
          drop = false
          throw new Error('rotation response lost')
        }
        return response
      },
      async () => {
        probes += 1
        return { ok: probeOk }
      }
    )
    await service.start()
    const setup = await service.retryProjectEvent('repo-1')
    expect(setup).toMatchObject({ ok: false, code: 'probe-failed' })
    drop = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect(await service.rotateProjectEventSecret('repo-1')).toMatchObject({
        ok: false,
        code: 'unknown-outcome'
      })
      const applied = gitlab.hooks[0].token
      const unverified = await service.rotateProjectEventSecret('repo-1')
      expect(unverified).toMatchObject({ ok: false, code: 'probe-failed' })
      expect(service.getProjectEventBinding('repo-1')?.state).toBe('failed')
      probeOk = true
      const recovered = await service.rotateProjectEventSecret('repo-1')
      expect(recovered.ok).toBe(true)
      expect(probes).toBe(3)
      expect(service.getProjectEventBinding('repo-1')).toMatchObject({
        state: 'connected',
        failure: null,
        rotationPending: false
      })
      const ledger = ForgeInboxLedger.open(dbPath, { hostId: 'host-1', secretStore: fakeStore() })
      try {
        const bindingId = recovered.binding?.bindingId ?? ''
        expect(
          authorizeProjectEventBinding(ledger.ledgerContext(), {
            bindingId,
            token: String(gitlab.hooks[0].token)
          }).ok
        ).toBe(true)
        expect(gitlab.created.slice(1, 4).every((entry) => entry.body.token === applied)).toBe(true)
      } finally {
        ledger.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  describe('removing the repository hook', () => {
    async function connectedService(
      exec?: (gitlab: ReturnType<typeof fakeGitlab>) => ReturnType<typeof fakeGitlab>['exec']
    ) {
      root = mkdtempSync(join(tmpdir(), 'forge-trigger-remove-'))
      const dbPath = join(root, 'forge-inbox.sqlite')
      const gitlab = fakeGitlab()
      const receiverSettings = createReceiverSettingsFixture()
      receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
      seedEnabledPolicy(dbPath, fakeStore())
      service = createService(dbPath, gitlab, receiverSettings, exec?.(gitlab) ?? gitlab.exec)
      await service.start()
      await waitFor(
        () => service?.getProjectEventBinding('repo-1')?.state === 'connected',
        'the connected binding'
      )
      return gitlab
    }

    it('deletes the GitLab hook, binding and link', async () => {
      const gitlab = await connectedService()

      const result = await service?.removeProjectEvent('repo-1')

      expect(result).toEqual({ ok: true, removed: true })
      expect(gitlab.hooks).toHaveLength(0)
      expect(service?.getProjectEventBinding('repo-1')).toBeNull()
    })

    it('drops the dead repo link on a GitLab refusal so a new repo id adopts the binding', async () => {
      let refuse = true
      const gitlab = await connectedService((fake) => async (args, options) => {
        if (refuse && args.includes('DELETE')) {
          throw new Error('network down')
        }
        return fake.exec(args, options)
      })
      const bindingId = service?.getProjectEventBinding('repo-1')?.bindingId

      const removed = await service?.removeProjectEvent('repo-1')

      expect(removed?.ok).toBe(false)
      expect(service?.getProjectEventBinding('repo-1')).toBeNull()
      refuse = false
      const readded = await service?.retryProjectEvent('repo-2')

      expect(readded?.ok).toBe(true)
      expect(readded?.binding?.bindingId).toBe(bindingId)
      expect(gitlab.hooks).toHaveLength(1)
    })

    it('retries a cleanup-failed binding without a link when the owner opens again', async () => {
      let refuse = true
      const gitlab = await connectedService((fake) => async (args, options) => {
        if (refuse && args.includes('DELETE')) {
          throw new Error('network down')
        }
        return fake.exec(args, options)
      })
      await service?.removeProjectEvent('repo-1')
      const policy = service?.getProjectEventPolicy('repo-1')
      await service?.updateProjectEventPolicy('repo-1', policy?.generation ?? 0, { enabled: false })
      await service?.stop()
      refuse = false
      const dbPath = join(root ?? '', 'forge-inbox.sqlite')
      const receiverSettings = createReceiverSettingsFixture()
      receiverSettings.update({ externalBaseUrl: 'https://orca.example.com' })
      service = createService(dbPath, gitlab, receiverSettings)

      await service.start()

      await waitFor(() => gitlab.hooks.length === 0, 'the retried cleanup')
    })

    it('says so when the owner is not running instead of silently skipping', async () => {
      root = mkdtempSync(join(tmpdir(), 'forge-trigger-remove-idle-'))
      service = createService(
        join(root, 'forge-inbox.sqlite'),
        fakeGitlab(),
        createReceiverSettingsFixture()
      )

      await expect(service.removeProjectEvent('repo-1')).resolves.toEqual({
        ok: false,
        code: 'not-running'
      })
    })

    it('leaves the hook in place when the policy is only disabled', async () => {
      const gitlab = await connectedService()
      const policy = service?.getProjectEventPolicy('repo-1')

      await service?.updateProjectEventPolicy('repo-1', policy?.generation ?? 0, {
        enabled: false
      })

      expect(gitlab.hooks).toHaveLength(1)
      expect(gitlab.deleted).toEqual([])
    })
  })
})
