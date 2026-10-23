import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { startForgeInboxForHost } from './forge-inbox-host-startup'
import type { ForgeInboxOwnerService } from './forge-inbox-owner-service'
import { RuntimeForgeInboxController } from '../runtime/runtime-forge-inbox-controller'
import {
  connectRefused,
  createOwnerFixture,
  damageLedger,
  seedLedger,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('forge inbox host startup', () => {
  let fx: OwnerFixture
  const extraRoots: string[] = []
  const started: ForgeInboxOwnerService[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const service of started.splice(0)) {
      await service.stop()
    }
    for (const root of extraRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    await fx?.dispose()
  })

  function attachTo(sink: ForgeInboxOwnerService[]) {
    return (service: ForgeInboxOwnerService) => {
      sink.push(service)
      started.push(service)
    }
  }

  it('keeps one dormant service per profile directory and creates a ledger only where it is used', async () => {
    fx = createOwnerFixture()
    const other = mkdtempSync(join(tmpdir(), 'forge-host-other-'))
    extraRoots.push(other)
    const a: ForgeInboxOwnerService[] = []
    const b: ForgeInboxOwnerService[] = []

    const first = await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: attachTo(a)
    })
    const second = await startForgeInboxForHost({
      profileDirectory: other,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: attachTo(b)
    })

    expect([first, second]).toEqual([{ started: true }, { started: true }])
    expect(existsSync(join(fx.root, 'forge-inbox.db'))).toBe(false)
    expect(existsSync(join(other, 'forge-inbox.db'))).toBe(false)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    const port = await freePort()
    await provision(a[0]!, { enabled: false, bindAddress: '127.0.0.1', port })
    expect(existsSync(join(fx.root, 'forge-inbox.db'))).toBe(true)
    expect(existsSync(join(other, 'forge-inbox.db'))).toBe(false)
    expect(a[0]!.getConfig().config.instances).not.toEqual(b[0]!.getConfig().config.instances)
  })

  it('runs a queued analysis through the injected factory', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const services: ForgeInboxOwnerService[] = []
    const kinds: string[] = []
    let revisionAtFactory = -1

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: attachTo(services),
      analyse: (ledger) => {
        revisionAtFactory = ledger.getConfig().configRevision
        return async ({ run, bindSession }) => {
          kinds.push(run.analysisKind)
          bindSession('session-1')
          return { kind: 'analysed', result: { summary: 'Looks fine', concerns: [] } }
        }
      }
    })
    await provision(services[0]!, listenerOn(port), {
      project: { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }
    })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await services[0]!.settled()

    expect(revisionAtFactory).toBe(0)
    expect(kinds).toEqual(['merge_request'])
    expect(fx.rows('SELECT state, session_id FROM runs ORDER BY id')).toEqual([
      { state: 'succeeded', session_id: 'session-1' }
    ])
  })

  it('does not drain a recovered backlog until the network is ready', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service({ now: () => Date.now() - 120_000 })
    await seed.start()
    await provision(seed, listenerOn(port))
    fx.gate.hold()
    fx.gate.delayAbortCompletion()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    const stopping = seed.stop()
    await fx.gate.abortObserved()
    fx.gate.releaseAbortedRequests()
    await stopping
    fx.gate.release()
    const requestsBefore = fx.gitlab.requests.length
    const ready = Promise.withResolvers<void>()
    const services: ForgeInboxOwnerService[] = []

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: ready.promise,
      notify: () => undefined,
      attach: attachTo(services)
    })
    for (let i = 0; i < 10; i++) {
      await tick()
    }

    expect(services[0]!.getConfig().config.listener).toMatchObject({ enabled: true, port })
    expect(services[0]!.status().listener.listening).toBe(true)
    expect(fx.gitlab.requests).toHaveLength(requestsBefore)
    expect(fx.deliveries()).toMatchObject([{ state: 'pending' }])

    ready.resolve()
    await services[0]!.settled()
    // No credential in the default store, so a drain that ran parks the row instead of fetching.
    expect(fx.deliveries()).toMatchObject([{ state: 'needs-auth' }])
  })

  it('treats a rejected network readiness as ready and logs one value-free line', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service({ now: () => Date.now() - 120_000 })
    await seed.start()
    await provision(seed, listenerOn(port))
    fx.gate.hold()
    fx.gate.delayAbortCompletion()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    const stopping = seed.stop()
    await fx.gate.abortObserved()
    fx.gate.releaseAbortedRequests()
    await stopping
    fx.gate.release()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services: ForgeInboxOwnerService[] = []

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.reject(new Error('proxy secret-value')),
      notify: () => undefined,
      attach: attachTo(services)
    })
    await services[0]!.settled()

    // No credential in the default store, so a drain that ran parks the row instead of fetching.
    expect(fx.deliveries()).toMatchObject([{ state: 'needs-auth' }])
    expect(warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value')
  })

  it('stops promptly even if network readiness never settles', async () => {
    fx = createOwnerFixture()
    const services: ForgeInboxOwnerService[] = []
    await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: new Promise<void>(() => {}),
      notify: () => undefined,
      attach: attachTo(services)
    })
    await expect(services[0]!.stop()).resolves.toBeUndefined()
  })

  it('starts dormant, without creating anything, when the profile directory has no ledger', async () => {
    fx = createOwnerFixture()
    const blocker = join(fx.root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const services: ForgeInboxOwnerService[] = []

    const result = await startForgeInboxForHost({
      profileDirectory: blocker,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: attachTo(services)
    })

    expect(result).toEqual({ started: true })
    expect(services[0]!.status().running).toBe(false)
    expect(existsSync(join(fx.root, 'forge-inbox.db'))).toBe(false)
  })

  it('reports a failed start by code only and creates no other ledger', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    damageLedger(fx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const attach = vi.fn()

    const result = await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach
    })

    expect(result.started).toBe(false)
    expect(result).toMatchObject({ code: expect.any(String) })
    expect(attach).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
    expect(JSON.stringify(error.mock.calls)).not.toContain(fx.root)
    mkdirSync(join(fx.root, 'sub'))
    expect(existsSync(join(fx.root, 'sub', 'forge-inbox.db'))).toBe(false)
  })

  async function seededListener() {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await provision(seed, listenerOn(port))
    await seed.stop()
    return port
  }

  it('closes the ledger and the listener when a stop lands while the start is still in flight', async () => {
    const port = await seededListener()
    const controller = new RuntimeForgeInboxController()

    const starting = startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: (service) => controller.attach(service)
    })
    const stopping = controller.stopForgeInboxService()
    await Promise.all([starting, stopping])

    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
    expect(controller.service().status().running).toBe(false)
    expect(controller.keepsHostBusy()).toBe(false)
  })

  it('never starts a service once a stop was already requested', async () => {
    const port = await seededListener()
    const controller = new RuntimeForgeInboxController()
    await controller.stopForgeInboxService()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: (service) => controller.attach(service)
    })

    expect(result.started).toBe(false)
    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('resolves cleanly, with the stop winning, when a start over damaged configuration is being stopped', async () => {
    await seededListener()
    damageLedger(fx)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new RuntimeForgeInboxController()

    const starting = startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: (service) => controller.attach(service)
    })
    const stopping = controller.stopForgeInboxService()

    await expect(starting).resolves.toEqual({ started: true })
    await expect(stopping).resolves.toBeUndefined()
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
  })
})
