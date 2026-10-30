import { afterEach, describe, expect, it } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { INSTANCE_ID, WEBHOOK_TOKEN } from './forge-inbox-webhook-test-harness'
import {
  API_READ_TOKEN,
  connectRefused,
  createOwnerFixture,
  freePort,
  holdPort,
  listenerOn,
  openIdleSocket,
  ownerConfig,
  postHook,
  PROJECT_EVENT_BINDING_ID,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

describe('forge inbox owner service listener', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('binds nothing while the listener is disabled', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, { enabled: false, bindAddress: '127.0.0.1', port })

    expect(service.status().listener).toEqual({
      enabled: false,
      listening: false,
      port: null,
      error: null
    })
    expect(await connectRefused(port)).toBe(true)
  })

  it('shows an occupied port, keeps the intent, never falls back, and binds once the port is repaired', async () => {
    fx = createOwnerFixture()
    const held = await holdPort()
    const service = fx.service()
    await service.start()

    await fx.provision(service, listenerOn(held.port))

    expect(service.getConfig().config.listener).toMatchObject({ enabled: true, port: held.port })
    expect(service.status().listener).toEqual({
      enabled: true,
      listening: false,
      port: null,
      error: 'EADDRINUSE'
    })

    await held.release()
    await service.reconcileReceiverSettings()

    expect(service.status().listener).toEqual({
      enabled: true,
      listening: true,
      port: held.port,
      error: null
    })
    await expect(postHook(held.port, mergeRequestHookBody(), 'm-1')).resolves.toMatchObject({
      status: 202
    })
  })

  it('causes no socket effects when the config write loses the revision race', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()
    const port = await freePort()
    const revision = service.getConfig().configRevision
    await fx.provision(service, { enabled: false, bindAddress: '127.0.0.1', port })

    const stale = await service.updateConfig(revision, ownerConfig(listenerOn(port)))

    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision' })
    expect(service.getConfig().config.listener.enabled).toBe(false)
    expect(service.status().listener.listening).toBe(false)
    expect(await connectRefused(port)).toBe(true)
  })

  it('keeps the same listener, and its open connections, across credential and policy changes', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port))
    const idle = await openIdleSocket(port)

    const rotated = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'webhook',
      secret: 'whk-retired-token',
      expectedRevision: service.getConfig().configRevision
    })
    expect(rotated.ok).toBe(true)
    const binding = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
    try {
      const secret = setProjectBindingSecret(binding.ledgerContext(), {
        bindingId: PROJECT_EVENT_BINDING_ID,
        secret: 'whk-rotated-token'
      })
      expect(secret.ok).toBe(true)
    } finally {
      binding.close()
    }
    const policy = await service.updateConfig(
      service.getConfig().configRevision,
      ownerConfig(listenerOn(port), { automaticAnalysis: false, events: { reviewRequests: false } })
    )
    expect(policy.ok).toBe(true)

    expect(service.status().listener).toMatchObject({ listening: true, port })
    await expect(
      postHook(port, mergeRequestHookBody(), 'm-1', WEBHOOK_TOKEN)
    ).resolves.toMatchObject({
      status: 401
    })
    await expect(
      postHook(port, mergeRequestHookBody(), 'm-2', 'whk-rotated-token')
    ).resolves.toMatchObject({ status: 202 })
    // Closing is only visible after round trips; a restarted listener destroys idle sockets.
    expect(idle.closed()).toBe(false)
    idle.socket.destroy()
  })

  it('releases the old port when the bind target moves and can rebind it later', async () => {
    fx = createOwnerFixture()
    const first = await freePort()
    const second = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(first))
    const idle = await openIdleSocket(first)

    // Ordering is asserted through port release and rebind, not direct event ordering.
    await fx.configureReceiver(service, listenerOn(second))
    await waitUntilClosed(idle)
    expect(await connectRefused(first)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: second, error: null })
    await expect(postHook(second, mergeRequestHookBody(), 'm-1')).resolves.toMatchObject({
      status: 202
    })

    await fx.configureReceiver(service, listenerOn(first))
    expect(await connectRefused(second)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: first, error: null })
  })

  it('acknowledges only committed deliveries and turns them into items through the real worker', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port))

    const reply = await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')

    expect(reply).toMatchObject({ status: 202 })
    expect(fx.deliveries()).toHaveLength(1)
    await service.settled()
    // A binding delivery is not the retired instance worker's work, so it stays pending and unconsumed.
    expect(fx.items()).toEqual([])
    expect(fx.deliveries()).toMatchObject([{ state: 'pending', attempts: 0 }])
  })

  it('keeps the delivery and its queued decision pending after the api-read credential arrives', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port), { apiRead: null })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    expect(fx.deliveries()).toMatchObject([{ state: 'pending', attempts: 0 }])
    expect(service.status().work).toMatchObject({ pending: 1, needsAuth: 0 })

    const stored = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret: API_READ_TOKEN,
      expectedRevision: service.getConfig().configRevision
    })
    expect(stored.ok).toBe(true)
    await service.settled()

    expect(fx.items()).toEqual([])
    expect(fx.deliveries()).toMatchObject([{ state: 'pending', attempts: 0 }])
  })

  it('keeps binding deliveries pending and reports their queued decisions', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port))

    for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) {
      await expect(
        postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), id)
      ).resolves.toMatchObject({ status: 202 })
    }
    await service.settled()

    expect(fx.items()).toEqual([])
    expect(fx.gitlab.requests).toEqual([])
    expect(fx.deliveries()).toMatchObject([
      { state: 'pending', attempts: 0 },
      { state: 'pending', attempts: 0 },
      { state: 'pending', attempts: 0 },
      { state: 'pending', attempts: 0 }
    ])
    expect(service.status().work).toMatchObject({ pending: 4, draining: false })
    // Settled joins active work; queued decisions still make the owner busy without an adapter.
    expect(service.idle()).toBe(false)
    expect(fx.rows('SELECT decision_state FROM webhook_deliveries')).toEqual([
      { decision_state: 'queued' },
      { decision_state: 'queued' },
      { decision_state: 'queued' },
      { decision_state: 'queued' }
    ])
  })

  it('is idle after decisions block, without retrying them on unrelated credential changes', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    let calls = 0
    const service = fx.service({
      decideProjectEvent: async () => {
        calls += 1
        return { ok: false, code: 'unauthorized' }
      }
    })
    expect(service.idle()).toBe(true)
    await service.start()
    await fx.provision(service, listenerOn(port), { apiRead: null })
    expect(service.idle()).toBe(true)

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    // An unauthorized decision is terminal: the row is finished instead of holding queue capacity.
    expect(service.status().work).toMatchObject({ pending: 0, needsAuth: 0 })
    expect(service.idle()).toBe(true)
    expect(calls).toBe(1)
    expect(
      fx.rows('SELECT state, decision_state, last_error_code FROM webhook_deliveries')
    ).toEqual([{ state: 'failed', decision_state: 'blocked', last_error_code: 'unauthorized' }])

    await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret: API_READ_TOKEN,
      expectedRevision: service.getConfig().configRevision
    })
    await service.settled()
    expect(service.idle()).toBe(true)
    expect(calls).toBe(1)
    expect(fx.items()).toEqual([])

    fx.gitlab.state.override = () => new Response('{}', { status: 500 })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-2')
    await service.settled()
    expect(service.status().work.pending).toBe(0)
    expect(service.idle()).toBe(true)
    expect(calls).toBe(2)
    expect(fx.rows('SELECT decision_state, attempts FROM webhook_deliveries')).toEqual([
      { decision_state: 'blocked', attempts: 1 },
      { decision_state: 'blocked', attempts: 1 }
    ])
  })

  it('leaves parked deliveries parked and does no work when non-api-read credentials are cleared', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port), { apiRead: null })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    for (const kind of ['api-write', 'webhook'] as const) {
      await service.setCredential({
        instanceId: INSTANCE_ID,
        kind,
        secret: `glpat-${kind}-token`,
        expectedRevision: service.getConfig().configRevision
      })
      const cleared = await service.clearCredential({
        instanceId: INSTANCE_ID,
        kind,
        expectedRevision: service.getConfig().configRevision
      })
      expect(cleared.ok).toBe(true)
    }
    await service.settled()

    expect(fx.deliveries()).toMatchObject([{ state: 'pending', attempts: 0 }])
    expect(fx.gitlab.requests).toEqual([])
  })
})

async function waitUntilClosed(idle: {
  socket: { once: (e: 'close', f: () => void) => void }
  closed: () => boolean
}) {
  if (!idle.closed()) {
    await new Promise<void>((resolve) => idle.socket.once('close', resolve))
  }
}
