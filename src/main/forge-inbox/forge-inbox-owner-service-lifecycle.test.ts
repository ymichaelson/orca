import { existsSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { ForgeInboxOwnerNotRunningError } from './forge-inbox-owner-errors'
import {
  connectRefused,
  createOwnerFixture,
  freePort,
  listenerOn,
  holdRequestMidBody,
  ownerConfig,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import {
  createWorkerRig,
  mergeRequestHookBody as rigBody
} from './forge-inbox-webhook-worker-test-kit'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('forge inbox owner service stop and restart', () => {
  let fx: OwnerFixture
  afterEach(() => {
    vi.useRealTimers()
    return fx.dispose()
  })

  it('stops admission, then aborts API work, then waits for the worker before closing the ledger', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port))
    fx.gate.hold()
    fx.gate.delayAbortCompletion()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()

    let stopped = false
    const stopping = service.stop().then(() => (stopped = true))
    await fx.gate.abortObserved()

    expect(await connectRefused(port)).toBe(true)
    for (let i = 0; i < 5; i++) {
      await tick()
    }
    expect(stopped).toBe(false)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(true)

    fx.gate.releaseAbortedRequests()
    await stopping

    expect(service.status().running).toBe(false)
    expect(() => service.getConfig()).toThrow()
    expect(fx.deliveries()).toMatchObject([{ state: 'pending', attempts: 1 }])
    expect(fx.items()).toEqual([])
    await expect(service.stop()).resolves.toBeUndefined()
  })

  it('leaves no wal file behind and fires nothing after stop, and the data reopens intact', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const first = fx.service()
    await first.start()
    await provision(first, listenerOn(port))
    fx.gate.hold()
    fx.gate.delayAbortCompletion()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    const stopping = first.stop()
    await fx.gate.abortObserved()
    fx.gate.releaseAbortedRequests()
    await stopping
    const requestsAtStop = fx.gitlab.requests.length

    fx.gate.release()
    await tick()
    expect(fx.gitlab.requests).toHaveLength(requestsAtStop)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)

    // The cancelled row keeps a durable 30s lease, so the reopened service runs past it.
    const second = fx.service({ now: () => Date.now() + 60_000 })
    await second.start()
    await second.settled()

    expect(second.getConfig().config.listener).toMatchObject({ enabled: true, port })
    expect(fx.items()).toMatchObject([{ kind: 'merge_request', iid: 7 }])
    expect(fx.deliveries()).toMatchObject([{ state: 'done' }])
  })

  it('releases the ledger when start fails on unreadable stored configuration', async () => {
    fx = createOwnerFixture()
    const seeded = fx.service()
    await seeded.start()
    await provision(seeded, { enabled: false, bindAddress: '127.0.0.1', port: await freePort() })
    await seeded.stop()
    const damage = new Database(fx.dbPath)
    damage.prepare("UPDATE meta SET value = 'not json' WHERE key = 'config_json'").run()
    damage.close()

    const broken = fx.service()
    await expect(broken.start()).rejects.toThrow()

    expect(broken.status().running).toBe(false)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    await expect(broken.stop()).resolves.toBeUndefined()
  })
})

describe('forge inbox owner service stop with a listener that is slow to close', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('cancels the worker without waiting for the listener to finish closing', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service({ ingress: { requestDeadlineMs: 30_000, shutdownGraceMs: 20_000 } })
    await service.start()
    await provision(service, listenerOn(port))
    fx.gate.hold()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    // Provably in flight: the server has already answered 100 Continue for this request.
    const slow = await holdRequestMidBody(port, 'm-2')

    const stopping = service.stop()
    try {
      await fx.gate.abortObserved()
    } finally {
      slow.release()
    }
    await stopping
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
  })
})

describe('forge inbox owner service start racing stop', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('returns the committed config result when stop lands during the reconcile', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()
    const port = await freePort()
    await service.updateConfig(0, ownerConfig({ enabled: false, bindAddress: '127.0.0.1', port }))

    const updating = service.updateConfig(
      service.getConfig().configRevision,
      ownerConfig(listenerOn(port))
    )
    const stopping = service.stop()

    await expect(updating).resolves.toMatchObject({ ok: true })
    await expect(stopping).resolves.toBeUndefined()
    expect(await connectRefused(port)).toBe(true)
  })

  it('reports a stopped service with a typed error and keeps a failed start final', async () => {
    fx = createOwnerFixture()
    writeFileSync(fx.dbPath, 'this is not a sqlite database'.repeat(100))
    const broken = fx.service()

    await expect(broken.start()).rejects.toThrow()
    expect(broken.status()).toMatchObject({ running: false, phase: 'stopped' })
    expect(() => broken.getConfig()).toThrow(ForgeInboxOwnerNotRunningError)
    await expect(broken.updateConfig(0, {})).rejects.toMatchObject({
      code: 'forge-inbox-owner-not-running'
    })
    await expect(broken.start()).rejects.toBeInstanceOf(ForgeInboxOwnerNotRunningError)
    await expect(broken.stop()).resolves.toBeUndefined()
  })

  it('closes the ledger once, and the stop wins, when it lands while a start over damaged configuration is reconciling', async () => {
    fx = createOwnerFixture()
    const seeded = fx.service()
    await seeded.start()
    await provision(seeded, { enabled: false, bindAddress: '127.0.0.1', port: await freePort() })
    await seeded.stop()
    const damage = new Database(fx.dbPath)
    damage.prepare("UPDATE meta SET value = 'not json' WHERE key = 'config_json'").run()
    damage.close()

    const racing = fx.service()
    const starting = racing.start()
    const stopping = racing.stop()
    const [started, stopped] = await Promise.allSettled([starting, stopping])

    expect(stopped.status).toBe('fulfilled')
    // The stop fences the reconcile before it reads the damaged configuration, so nothing fails.
    expect(started.status).toBe('fulfilled')
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
    const repair = new Database(fx.dbPath)
    repair
      .prepare("UPDATE meta SET value = ? WHERE key = 'config_json'")
      .run(JSON.stringify({ schemaVersion: 1, listener: { enabled: false }, instances: [] }))
    repair.close()
    const reopened = fx.service()
    await expect(reopened.start()).resolves.toBeUndefined()
  })
})

describe('forge inbox owner service retry scheduling', () => {
  let rig: ReturnType<typeof createWorkerRig>
  afterEach(() => {
    vi.useRealTimers()
    rig.dispose()
  })

  it('keeps draining a backlog beyond one batch without waiting for a timer', async () => {
    rig = createWorkerRig()
    for (let i = 0; i < 101; i++) {
      rig.admit('push', null, JSON.stringify({ object_kind: 'push' }))
    }
    rig.ledger.close()
    const { createForgeInboxOwnerService } = await import('./forge-inbox-owner-service')
    const service = createForgeInboxOwnerService({
      dbPath: rig.harness.dbPath,
      http: { fetch: (url) => rig.gitlab.fetch(url) },
      secretStore: rig.harness.store
    })

    await service.start()
    await service.settled()

    expect(service.status().work.pending).toBe(0)
    await service.stop()
  })

  it('retries at the persisted next_attempt_at, also after the service is reopened', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'))
    rig = createWorkerRig({ apiToken: null })
    rig.writeApiToken('glpat-service-read')
    rig.admit('merge_request', rigBody({ reviewers: ['me'] }))
    rig.ledger.close()
    rig.gitlab.state.override = () => new Response('{}', { status: 500 })
    const open = () =>
      import('./forge-inbox-owner-service').then(({ createForgeInboxOwnerService }) =>
        createForgeInboxOwnerService({
          dbPath: rig.harness.dbPath,
          http: { fetch: (url) => rig.gitlab.fetch(url) },
          secretStore: rig.harness.store
        })
      )

    const first = await open()
    await first.start()
    await first.settled()
    const afterFailure = rig.gitlab.requests.length
    expect(afterFailure).toBeGreaterThan(0)
    const [row] = new Database(rig.harness.dbPath)
      .prepare('SELECT next_attempt_at FROM webhook_deliveries')
      .all()
    const retryAt = Number(row.next_attempt_at)
    expect(retryAt).toBeGreaterThan(Date.now())
    await first.stop()

    rig.gitlab.state.override = () => null
    const second = await open()
    await second.start()
    await second.settled()
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1)
    expect(rig.gitlab.requests).toHaveLength(afterFailure)
    await vi.advanceTimersByTimeAsync(1)
    await second.settled()

    const check = new Database(rig.harness.dbPath)
    expect(check.prepare('SELECT iid FROM items').all()).toHaveLength(1)
    check.close()
    await second.stop()
  })
})
