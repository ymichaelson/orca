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
  postHook,
  holdRequestMidBody,
  ownerConfig,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function decisionGate() {
  let started!: () => void
  let aborted!: () => void
  let release!: () => void
  const requestStarted = new Promise<void>((resolve) => (started = resolve))
  const abortObserved = new Promise<void>((resolve) => (aborted = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  let calls = 0
  return {
    decide: async (_input: unknown, signal?: AbortSignal) => {
      calls += 1
      started()
      signal?.addEventListener('abort', aborted, { once: true })
      await released
      return { ok: false, code: 'network' } as const
    },
    requestStarted,
    abortObserved,
    release,
    calls: () => calls
  }
}

const notifyDecision = () => ({
  ok: true as const,
  provider: 'jev' as const,
  model: 'jev-1',
  action: 'notify' as const,
  confidence: 0.9,
  probabilities: {
    record_only: 0.02,
    notify: 0.9,
    wait: 0.02,
    fetch_context: 0.02,
    dispatch_agent: 0.02,
    ask_user: 0.02
  },
  usage: { inputTokens: 12, outputTokens: 3 }
})

describe('forge inbox owner service stop and restart', () => {
  let fx: OwnerFixture
  afterEach(() => {
    vi.useRealTimers()
    return fx.dispose()
  })

  it('stops admission, then aborts the decision request, then waits for it before closing the ledger', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const gate = decisionGate()
    const service = fx.service({ decideProjectEvent: gate.decide })
    await service.start()
    await fx.provision(service, listenerOn(port))
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await gate.requestStarted

    let stopped = false
    const stopping = service.stop().then(() => (stopped = true))
    await gate.abortObserved

    expect(await connectRefused(port)).toBe(true)
    for (let i = 0; i < 5; i++) {
      await tick()
    }
    expect(stopped).toBe(false)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(true)

    gate.release()
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
    const gate = decisionGate()
    const first = fx.service({ decideProjectEvent: gate.decide })
    await first.start()
    await fx.provision(first, listenerOn(port))
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await gate.requestStarted
    const stopping = first.stop()
    await gate.abortObserved
    gate.release()
    await stopping
    const requestsAtStop = gate.calls()

    await tick()
    expect(gate.calls()).toBe(requestsAtStop)
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)

    const second = fx.service({ decideProjectEvent: async () => notifyDecision() })
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
    await fx.provision(seeded, { enabled: false, bindAddress: '127.0.0.1', port: await freePort() })
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

  it('cancels the decision request without waiting for the listener to finish closing', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const gate = decisionGate()
    const service = fx.service({
      ingress: { requestDeadlineMs: 30_000, shutdownGraceMs: 20_000 },
      decideProjectEvent: gate.decide
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await gate.requestStarted
    // Provably in flight: the server has already answered 100 Continue for this request.
    const slow = await holdRequestMidBody(port, 'm-2')

    const stopping = service.stop()
    try {
      await gate.abortObserved
    } finally {
      gate.release()
      slow.release()
    }
    await stopping
    expect(existsSync(`${fx.dbPath}-wal`)).toBe(false)
  })
})

describe('forge inbox owner service start racing stop', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('finishes a receiver reconcile without binding when stop wins', async () => {
    fx = createOwnerFixture()
    const service = fx.service()
    await service.start()
    const port = await freePort()
    await service.updateConfig(0, ownerConfig({ enabled: false, bindAddress: '127.0.0.1', port }))

    const updating = fx.configureReceiver(service, listenerOn(port))
    const stopping = service.stop()

    await expect(updating).resolves.toBeUndefined()
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
    await fx.provision(seeded, { enabled: false, bindAddress: '127.0.0.1', port: await freePort() })
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
  let fx: OwnerFixture | undefined
  afterEach(async () => {
    vi.useRealTimers()
    await fx?.dispose()
    fx = undefined
  })

  it('retries at the persisted next_attempt_at, also after the service is reopened', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    let requests = 0
    const first = fx.service({
      decideProjectEvent: async () => {
        requests += 1
        return { ok: false, code: 'network' }
      }
    })
    await first.start()
    await fx.provision(first, listenerOn(port))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'))
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'retry')
    await first.settled()
    const afterFailure = requests
    expect(afterFailure).toBeGreaterThan(0)
    const [row] = fx.rows('SELECT next_attempt_at FROM webhook_deliveries')
    const retryAt = Number(row.next_attempt_at)
    expect(retryAt).toBeGreaterThan(Date.now())
    await first.stop()

    const second = fx.service({
      decideProjectEvent: async () => {
        requests += 1
        return notifyDecision()
      }
    })
    await second.start()
    await second.settled()
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1)
    expect(requests).toBe(afterFailure)
    await vi.advanceTimersByTimeAsync(1)
    await second.settled()

    expect(fx.items()).toHaveLength(1)
    await second.stop()
  })
})
