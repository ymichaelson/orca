import { afterEach, describe, expect, it } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
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
  provision,
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
    await provision(service, { enabled: false, bindAddress: '127.0.0.1', port })

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

    await provision(service, listenerOn(held.port))

    expect(service.getConfig().config.listener).toMatchObject({ enabled: true, port: held.port })
    expect(service.status().listener).toEqual({
      enabled: true,
      listening: false,
      port: null,
      error: 'EADDRINUSE'
    })

    await held.release()
    const revision = service.getConfig().configRevision
    const repaired = await service.updateConfig(revision, ownerConfig(listenerOn(held.port)))
    expect(repaired.ok).toBe(true)

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
    await provision(service, { enabled: false, bindAddress: '127.0.0.1', port })

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
    await provision(service, listenerOn(port))
    const idle = await openIdleSocket(port)

    const rotated = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'webhook',
      secret: 'whk-rotated-token',
      expectedRevision: service.getConfig().configRevision
    })
    expect(rotated.ok).toBe(true)
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
    await provision(service, listenerOn(first))
    const idle = await openIdleSocket(first)

    // Ordering is asserted through port release and rebind, not direct event ordering.
    const moved = await service.updateConfig(
      service.getConfig().configRevision,
      ownerConfig(listenerOn(second))
    )

    expect(moved.ok).toBe(true)
    await waitUntilClosed(idle)
    expect(await connectRefused(first)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: second, error: null })
    await expect(postHook(second, mergeRequestHookBody(), 'm-1')).resolves.toMatchObject({
      status: 202
    })

    const back = await service.updateConfig(
      service.getConfig().configRevision,
      ownerConfig(listenerOn(first))
    )
    expect(back.ok).toBe(true)
    expect(await connectRefused(second)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: first, error: null })
  })

  it('acknowledges only committed deliveries and turns them into items through the real worker', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port))

    const reply = await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')

    expect(reply).toMatchObject({ status: 202 })
    expect(fx.deliveries()).toHaveLength(1)
    await service.settled()
    expect(fx.items()).toMatchObject([{ kind: 'merge_request', iid: 7 }])
    expect(fx.deliveries()).toMatchObject([{ state: 'done', body_bytes: 0 }])
  })

  it('processes parked deliveries once the api-read credential arrives', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port), { apiRead: null })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    expect(fx.deliveries()).toMatchObject([{ state: 'needs-auth' }])
    expect(service.status().work).toMatchObject({ pending: 0, needsAuth: 1 })

    const stored = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret: API_READ_TOKEN,
      expectedRevision: service.getConfig().configRevision
    })
    expect(stored.ok).toBe(true)
    await service.settled()

    expect(fx.items()).toHaveLength(1)
    expect(fx.deliveries()).toMatchObject([{ state: 'done' }])
  })

  it('retries the in-flight delivery as dirty after later admissions invalidate its project', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port))
    fx.gate.hold()

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    for (const id of ['m-2', 'm-3', 'm-4']) {
      await expect(
        postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), id)
      ).resolves.toMatchObject({
        status: 202
      })
    }
    expect(service.status().work.draining).toBe(true)
    fx.gate.release()
    await service.settled()

    // Each admission invalidates the project, so the snapshot taken before them is stale at ingest.
    const states = fx.rows(
      'SELECT state, attempts, last_error_code FROM webhook_deliveries ORDER BY id'
    )
    expect(states).toEqual([
      { state: 'pending', attempts: 1, last_error_code: 'dirty-observation' },
      { state: 'done', attempts: 1, last_error_code: null },
      { state: 'done', attempts: 1, last_error_code: null },
      { state: 'done', attempts: 1, last_error_code: null }
    ])
    expect(fx.items()).toHaveLength(1)
    const [retrying] = fx.deliveries()
    expect(service.status().work).toMatchObject({
      pending: 1,
      needsAuth: 0,
      nextAttemptAtMs: retrying.next_attempt_at,
      draining: false
    })
  })

  it('is idle with nothing pending or only parked deliveries, and busy while draining or retrying', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    expect(service.idle()).toBe(true)
    await service.start()
    await provision(service, listenerOn(port), { apiRead: null })
    expect(service.idle()).toBe(true)

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()
    expect(service.status().work.needsAuth).toBe(1)
    expect(service.idle()).toBe(true)

    fx.gate.hold()
    await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret: API_READ_TOKEN,
      expectedRevision: service.getConfig().configRevision
    })
    await fx.gate.requestBlocked()
    expect(service.idle()).toBe(false)
    fx.gate.release()
    await service.settled()
    expect(service.idle()).toBe(true)

    fx.gitlab.state.override = () => new Response('{}', { status: 500 })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-2')
    await service.settled()
    expect(service.status().work.pending).toBe(1)
    expect(service.idle()).toBe(false)
  })

  it('leaves parked deliveries parked and does no work when non-api-read credentials are cleared', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port), { apiRead: null })
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

    expect(fx.deliveries()).toMatchObject([{ state: 'needs-auth' }])
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
