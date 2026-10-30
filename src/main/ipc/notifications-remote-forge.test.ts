import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslHostGate from '../wsl/wsl-host-gate'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment
} from '../../shared/app-environment'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { FORGE_INBOX_NOTIFICATION_READER_CAPABILITY } from '../../shared/forge-inbox-runtime-capabilities'
import { encodePairingOffer } from '../../shared/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer,
  type SharedControlTestServer
} from '../../shared/remote-runtime-shared-control-test-server'
import {
  closeRemoteRuntimeRequestConnection,
  ensureRemoteRuntimeSharedControlConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  reconnectRemoteRuntimeSharedControlConnection,
  sendRemoteRuntimeSharedControlRequest
} from './runtime-environments/runtime-environment-request-connections'
import {
  resetNotificationDispatchMocks,
  readAuthorizationStatusMock,
  getDispatchHandler,
  getLoadSoundHandler
} from './notifications-test-harness'

const native = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ delivered: true })))
const brokenOwner = vi.hoisted(() => ({ id: '' }))
vi.mock('../wsl/wsl-host-gate', async (importOriginal) => {
  const original = await importOriginal<typeof WslHostGate>()
  return {
    ...original,
    isGatedOffWslHost: (environment: Parameters<typeof original.isGatedOffWslHost>[0]) => {
      if ('id' in environment && environment.id === brokenOwner.id) {
        throw new Error('invalid owner')
      }
      return original.isGatedOffWslHost(environment)
    }
  }
})
vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)
vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)
vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)
vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)
vi.mock('./native-notification-delivery', () => ({ deliverNativeNotification: native }))

import { registerNotificationHandlers } from './notifications'

const previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
let profile = ''
let environmentIds: string[] = []
let settings = getDefaultNotificationSettings()
const mobile = vi.fn()

function register(): void {
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests exercise only the supplied Store members.
    { getSettings: () => ({ notifications: settings }), getUI: () => ({}) } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exercised runtime paths use only these methods.
    {
      dispatchMobileNotification: mobile,
      onNotificationDispatched: () => () => {},
      forgeInboxServiceIfAttached: () => null,
      getTerminalHandleForPaneKey: () => null
    } as never
  )
}

async function addOwner(name: string): Promise<{ id: string; server: SharedControlTestServer }> {
  const server = await createSharedControlTestServer()
  const environment = addEnvironmentFromPairingCode(profile, {
    name,
    pairingCode: encodePairingOffer(server.offer)
  })
  environmentIds.push(environment.id)
  return { id: environment.id, server }
}

async function ensureSubscribed(owner: {
  id: string
  server: SharedControlTestServer
}): Promise<void> {
  ensureRemoteRuntimeSharedControlConnection(owner.id, owner.server.pairing)
  reconnectRemoteRuntimeSharedControlConnection(owner.id)
  await vi.waitFor(
    () => {
      expect(
        owner.server.requests.filter((request) => request.method === 'notifications.subscribe')
      ).toHaveLength(1)
    },
    { timeout: 1200, interval: 10 }
  )
}

function event(reason: 'project-event' | 'run-succeeded' = 'project-event', itemId = 1) {
  return {
    type: 'notification',
    source: 'forge-inbox',
    title: 'Forge Inbox',
    body: 'A project event needs your attention.',
    notificationId: `same:${itemId}`,
    attentionKey: `same:${itemId}`,
    forgeInbox: {
      ownerId: 'owner',
      instanceId: 'instance',
      itemId,
      reason,
      ...(reason === 'run-succeeded' ? { runId: itemId } : {})
    }
  }
}

async function sendEvent(owner: { id: string; server: SharedControlTestServer }, value: unknown) {
  owner.server.emitSubscription('notifications.subscribe', value)
  await sendRemoteRuntimeSharedControlRequest(
    owner.id,
    owner.server.pairing,
    'status.get',
    undefined,
    1000
  )
}

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'orca-remote-forge-'))
  brokenOwner.id = ''
  environmentIds = []
  settings = getDefaultNotificationSettings()
  resetNotificationDispatchMocks()
  native.mockClear()
  mobile.mockReset()
  readAuthorizationStatusMock.mockResolvedValue('authorized')
  setAppEnvironment({
    getPath: () => profile,
    getAppPath: () => profile,
    getVersion: () => '1.0.0',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of environmentIds) {
    closeRemoteRuntimeRequestConnection(id)
  }
  await closeSharedControlTestServers()
  if (previousEnvironment) {
    setAppEnvironment(previousEnvironment)
  }
  rmSync(profile, { recursive: true, force: true })
})

describe('remote Forge desktop notifications', () => {
  it('subscribes a persisted owner without opening a project', async () => {
    const owner = await addOwner('persisted')
    register()
    await vi.waitFor(
      () => {
        expect(
          owner.server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1)
      },
      { timeout: 1200, interval: 10 }
    )
    await sendEvent(owner, event())
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('recovers an initially unavailable persisted owner without opening a project', async () => {
    const server = await createSharedControlTestServer({
      closeBeforeFirstReady: true,
      resultForRequest: (method) =>
        method === 'status.get'
          ? { runtimeId: 'runtime-test', capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] }
          : { method }
    })
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'offline',
      pairingCode: encodePairingOffer(server.offer)
    })
    environmentIds.push(environment.id)
    register()
    await vi.waitFor(() => expect(server.connectionCount()).toBeGreaterThan(1), {
      timeout: 6000,
      interval: 10
    })
    await vi.waitFor(
      () =>
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1),
      { timeout: 6000, interval: 10 }
    )
    await sendEvent({ id: environment.id, server }, event())
    expect(native).toHaveBeenCalledTimes(1)
  }, 15000)

  it.each(['orca-environments.json', 'orca-environment-sidecar.json'])(
    'keeps ordinary handlers available when %s is corrupt',
    async (file) => {
      writeFileSync(join(profile, file), '{invalid json')
      expect(() => register()).not.toThrow()
      expect(getDispatchHandler()).toBeTypeOf('function')
      expect(getLoadSoundHandler()).toBeTypeOf('function')
      expect(native).not.toHaveBeenCalled()
    }
  )

  it('isolates one broken owner and still subscribes another', async () => {
    const bad = await addOwner('a-broken')
    const good = await addOwner('b-valid')
    brokenOwner.id = bad.id
    expect(() => register()).not.toThrow()
    expect(getDispatchHandler()).toBeTypeOf('function')
    expect(getLoadSoundHandler()).toBeTypeOf('function')
    await vi.waitFor(
      () =>
        expect(
          good.server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1),
      { timeout: 1200, interval: 10 }
    )
    await sendEvent(good, event())
    expect(native).toHaveBeenCalledTimes(1)
    expect(bad.server.connectionCount()).toBe(0)
  })

  it('does not retry an unsupported subscription for unrelated cached requests, but allows a replacement', async () => {
    const server = await createSharedControlTestServer({
      unsupportedMethods: ['notifications.subscribe']
    })
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'older',
      pairingCode: encodePairingOffer(server.offer)
    })
    environmentIds.push(environment.id)
    register()
    await vi.waitFor(
      () =>
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1),
      { timeout: 1200, interval: 10 }
    )
    for (let i = 0; i < 3; i++) {
      const response = await sendRemoteRuntimeSharedControlRequest(
        environment.id,
        server.pairing,
        'status.get',
        undefined,
        1000
      )
      expect(response.ok).toBe(true)
    }
    expect(
      server.requests.filter((request) => request.method === 'notifications.subscribe')
    ).toHaveLength(1)
    const replacement = await createSharedControlTestServer()
    const next = { id: environment.id, server: replacement }
    await ensureSubscribed(next)
    await sendEvent(next, event())
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('signals recovery and re-attaches after a retryable subscription error', async () => {
    const server = await createSharedControlTestServer({
      errorForRequest: (method) =>
        method === 'notifications.subscribe'
          ? { code: 'internal_error', message: 'Subscription temporarily unavailable' }
          : null,
      resultForRequest: (method) =>
        method === 'status.get'
          ? { runtimeId: 'runtime-test', capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] }
          : { method }
    })
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'retryable',
      pairingCode: encodePairingOffer(server.offer)
    })
    environmentIds.push(environment.id)
    register()
    await vi.waitFor(
      () =>
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe').length
        ).toBeGreaterThanOrEqual(1),
      { timeout: 1200, interval: 10 }
    )
    // initialFailure activates the status owner; its verified status re-attaches the stream.
    await vi.waitFor(
      () => expect(server.requests.some((request) => request.method === 'status.get')).toBe(true),
      { timeout: 6000, interval: 10 }
    )
    await vi.waitFor(
      () =>
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe').length
        ).toBeGreaterThanOrEqual(2),
      { timeout: 6000, interval: 10 }
    )
  })

  it('rejects empty or oversized ready metadata until a valid ready frame', async () => {
    const server = await createSharedControlTestServer({ delaySubscriptionReady: true })
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'pending',
      pairingCode: encodePairingOffer(server.offer)
    })
    environmentIds.push(environment.id)
    const owner = { id: environment.id, server }
    register()
    await vi.waitFor(
      () =>
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1),
      { timeout: 1200, interval: 10 }
    )
    for (const ready of [
      { subscriptionId: '', epoch: 'epoch' },
      { subscriptionId: 'x'.repeat(4097), epoch: 'epoch' },
      { subscriptionId: 'subscription', epoch: '' },
      { subscriptionId: 'subscription', epoch: 'x'.repeat(4097) },
      // Pinned: readiness needs both bounded ids, so a missing one stays disabled too.
      { subscriptionId: 'subscription' },
      { epoch: 'epoch' }
    ]) {
      server.emitSubscription('notifications.subscribe', { type: 'ready', ...ready })
      await sendEvent(owner, event())
    }
    expect(native).not.toHaveBeenCalled()
    server.emitSubscription('notifications.subscribe', {
      type: 'ready',
      subscriptionId: 'subscription',
      epoch: 'epoch'
    })
    await sendEvent(owner, event())
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('closes a subscription removed before its ready frame', async () => {
    const server = await createSharedControlTestServer({ delaySubscriptionReady: true })
    const environment = addEnvironmentFromPairingCode(profile, {
      name: 'pending',
      pairingCode: encodePairingOffer(server.offer)
    })
    environmentIds.push(environment.id)
    register()
    await vi.waitFor(
      () => {
        expect(
          server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(1)
      },
      { timeout: 1200, interval: 10 }
    )
    closeRemoteRuntimeRequestConnection(environment.id)
    server.emitSubscription('notifications.subscribe', event())
    expect(getRemoteRuntimeSharedControlDiagnostics(environment.id)).toBeNull()
    expect(native).not.toHaveBeenCalled()
  })

  it('subscribes existing and later owner connections and delivers equal ids independently', async () => {
    const first = await addOwner('first')
    ensureRemoteRuntimeSharedControlConnection(first.id, first.server.pairing)
    register()
    const second = await addOwner('second')
    await Promise.all([ensureSubscribed(first), ensureSubscribed(second)])
    expect(first.server.auths).toContainEqual(
      expect.objectContaining({
        clientCapabilities: expect.arrayContaining([FORGE_INBOX_NOTIFICATION_READER_CAPABILITY])
      })
    )
    expect(second.server.auths).toContainEqual(
      expect.objectContaining({
        clientCapabilities: expect.arrayContaining([FORGE_INBOX_NOTIFICATION_READER_CAPABILITY])
      })
    )

    await sendEvent(first, { ...event(), executionHost: 'local' })
    await sendEvent(second, event())
    expect(native).toHaveBeenCalledTimes(2)
    expect(native.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        notificationSourceId: `runtime:${first.id}`,
        forgeInbox: expect.objectContaining({ executionHostId: `runtime:${first.id}` })
      }),
      expect.objectContaining({
        notificationSourceId: `runtime:${second.id}`,
        forgeInbox: expect.objectContaining({ executionHostId: `runtime:${second.id}` })
      })
    ])
    expect(mobile).not.toHaveBeenCalled()
  })

  it('applies this desktop’s master, owner mute and completed-run settings', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)

    settings.forgeInbox = false
    await sendEvent(owner, event('project-event', 1))
    settings.forgeInbox = true
    settings.mutedNotificationSourceIds = [`runtime:${owner.id}`]
    await sendEvent(owner, event('project-event', 2))
    settings.mutedNotificationSourceIds = []
    await sendEvent(owner, event('run-succeeded', 3))
    expect(native).not.toHaveBeenCalled()
    settings.forgeInboxCompletedRuns = true
    await sendEvent(owner, event('run-succeeded', 4))
    expect(native).toHaveBeenCalledTimes(1)
    expect(mobile).not.toHaveBeenCalled()
  })

  it('uses fixed safe copy instead of remote title and body', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    await sendEvent(owner, {
      ...event(),
      title: 'secret-token-title',
      body: '<script>secret-token-body</script> https://example.invalid/private'
    })
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0]?.[0]).toMatchObject({
      forgeInbox: { title: 'Forge Inbox', body: 'A project event needs your attention.' }
    })
    expect(JSON.stringify(native.mock.calls)).not.toContain('secret-token')
    expect(JSON.stringify(native.mock.calls)).not.toContain('<script>')
    expect(JSON.stringify(native.mock.calls)).not.toContain('example.invalid')
  })

  it('drops invalid Forge frames and never routes their claimed host', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    await sendEvent(owner, { ...event(), forgeInbox: { ownerId: 'owner', itemId: -1 } })
    await sendEvent(owner, { ...event(), source: 'terminal-bell' })
    expect(native).not.toHaveBeenCalled()
    await sendEvent(owner, { ...event(), executionHost: 'local' })
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0]?.[0]).toMatchObject({
      forgeInbox: { executionHostId: `runtime:${owner.id}` }
    })
  })

  it('validates remote subject and cursor fields before retaining or delivering them', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    const base = event()
    const badSubjects = [
      { ownerId: '' },
      { ownerId: 'x'.repeat(4097) },
      { instanceId: '' },
      { instanceId: 'x'.repeat(4097) },
      { trigger: '' },
      { trigger: 'x'.repeat(4097) },
      { eventId: -1 },
      { runId: '1' },
      { proposalId: 0 }
    ]
    for (const bad of badSubjects) {
      await sendEvent(owner, { ...base, forgeInbox: { ...base.forgeInbox, ...bad } })
    }
    for (const metadata of [
      { notificationEpoch: '', notificationSeq: 1 },
      { notificationEpoch: 'x'.repeat(4097), notificationSeq: 1 },
      { notificationEpoch: 'epoch', notificationSeq: 0 },
      { notificationEpoch: 'epoch', notificationSeq: -1 },
      { notificationEpoch: 'epoch', notificationSeq: 1.5 }
    ]) {
      await sendEvent(owner, { ...base, ...metadata })
    }
    expect(native).not.toHaveBeenCalled()
    await sendEvent(owner, {
      ...base,
      notificationEpoch: 'epoch',
      notificationSeq: 1,
      forgeInbox: { ...base.forgeInbox, extra: 'opaque-secret' }
    })
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0]?.[0]).toMatchObject({ forgeInbox: { subject: base.forgeInbox } })
    expect(JSON.stringify(native.mock.calls)).not.toContain('opaque-secret')
  })

  it('deduplicates metadata-free frames beyond cooldown and keeps distinct fallback identities', async () => {
    const first = await addOwner('first')
    const second = await addOwner('second')
    register()
    await Promise.all([ensureSubscribed(first), ensureSubscribed(second)])
    const legacy = (itemId: number) => {
      const {
        notificationId: _notificationId,
        attentionKey: _attentionKey,
        ...value
      } = event('project-event', itemId)
      return value
    }
    await sendEvent(first, legacy(1))
    expect(native).toHaveBeenCalledTimes(1)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
    await sendEvent(first, legacy(1))
    expect(native).toHaveBeenCalledTimes(1)
    clock.mockRestore()
    first.server.closeClients()
    await vi.waitFor(
      () =>
        expect(
          first.server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(2),
      { timeout: 6000, interval: 10 }
    )
    await sendEvent(first, legacy(1))
    expect(native).toHaveBeenCalledTimes(1)
    await sendEvent(first, legacy(2))
    await sendEvent(second, legacy(1))
    expect(native).toHaveBeenCalledTimes(3)
    const ids = native.mock.calls.map(([request]) => {
      if (typeof request !== 'object' || request === null || !('notificationId' in request)) {
        return undefined
      }
      return request.notificationId
    })
    expect(new Set(ids).size).toBe(3)
    expect(ids).not.toContain(undefined)
  }, 15000)

  it.each(['cursor-first', 'cursor-later', 'id-first', 'id-later'] as const)(
    'deduplicates optional metadata transitions across cooldown and reconnect: %s',
    async (mode) => {
      const owner = await addOwner('remote')
      register()
      await ensureSubscribed(owner)
      const { notificationId: _id, ...withoutId } = event()
      const withCursor = { ...withoutId, notificationEpoch: 'epoch', notificationSeq: 1 }
      const withId = event()
      const first = mode === 'cursor-first' ? withCursor : mode === 'id-first' ? withId : withoutId
      const second = mode === 'cursor-later' ? withCursor : mode === 'id-later' ? withId : withoutId
      await sendEvent(owner, first)
      expect(native).toHaveBeenCalledTimes(1)
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
      await sendEvent(owner, second)
      expect(native).toHaveBeenCalledTimes(1)
      clock.mockRestore()
      owner.server.closeClients()
      await vi.waitFor(
        () =>
          expect(
            owner.server.requests.filter((request) => request.method === 'notifications.subscribe')
          ).toHaveLength(2),
        { timeout: 6000, interval: 10 }
      )
      // Why: this send must sit outside the 5s desktop cooldown, or the cooldown hides a lost dedupe.
      const reconnectClock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
      await sendEvent(owner, second)
      reconnectClock.mockRestore()
      expect(native).toHaveBeenCalledTimes(1)
      await sendEvent(owner, {
        ...event('project-event', 2),
        notificationEpoch: 'epoch',
        notificationSeq: 2,
        forgeInbox: { ...event('project-event', 2).forgeInbox, eventId: 2 }
      })
      expect(native).toHaveBeenCalledTimes(2)
    },
    15000
  )

  it('preserves two distinct cursor identities for the same subject', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    await sendEvent(owner, { ...event(), notificationEpoch: 'epoch', notificationSeq: 1 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
    await sendEvent(owner, { ...event(), notificationEpoch: 'epoch', notificationSeq: 2 })
    clock.mockRestore()
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('replaces the old paired transport without accepting its later events', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    const replacement = await createSharedControlTestServer()
    const next = { id: owner.id, server: replacement }
    await ensureSubscribed(next)
    owner.server.emitSubscription('notifications.subscribe', event())
    await sendEvent(next, event('project-event', 2))
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0]?.[0]).toMatchObject({
      forgeInbox: { subject: { itemId: 2 }, executionHostId: `runtime:${owner.id}` }
    })
  })

  it('resubscribes after disconnection without replaying banners and retires on removal', async () => {
    const owner = await addOwner('remote')
    register()
    await ensureSubscribed(owner)
    await sendEvent(owner, { ...event(), notificationEpoch: 'epoch', notificationSeq: 1 })
    expect(native).toHaveBeenCalledTimes(1)
    owner.server.closeClients()
    await vi.waitFor(
      () => {
        reconnectRemoteRuntimeSharedControlConnection(owner.id)
        expect(
          owner.server.requests.filter((request) => request.method === 'notifications.subscribe')
        ).toHaveLength(2)
      },
      { timeout: 2000, interval: 10 }
    )
    expect(native).toHaveBeenCalledTimes(1)
    await sendEvent(owner, {
      ...event('project-event', 2),
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
    expect(native).toHaveBeenCalledTimes(1)
    await sendEvent(owner, {
      ...event('project-event', 3),
      notificationEpoch: 'epoch',
      notificationSeq: 2
    })
    expect(native).toHaveBeenCalledTimes(2)
    closeRemoteRuntimeRequestConnection(owner.id)
    owner.server.emitSubscription('notifications.subscribe', event('project-event', 4))
    expect(native).toHaveBeenCalledTimes(2)
  })
})
