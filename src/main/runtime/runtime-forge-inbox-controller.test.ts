import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from '../forge-inbox/forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  holdPort,
  listenerOn,
  ownerConfig,
  postHook,
  provision,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import { RuntimeForgeInboxController } from './runtime-forge-inbox-controller'

const DISABLED = (port: number) => ({ enabled: false, bindAddress: '127.0.0.1', port })

describe('runtime forge inbox controller', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  async function attached(options: Parameters<OwnerFixture['service']>[0] = {}) {
    const controller = new RuntimeForgeInboxController()
    const service = fx.service(options)
    await service.start()
    controller.attach(service)
    return { controller, service }
  }

  it('is unavailable until a service is attached and idle without one', () => {
    fx = createOwnerFixture()
    const controller = new RuntimeForgeInboxController()
    expect(() => controller.service()).toThrow()
    expect(controller.keepsHostBusy()).toBe(false)
  })

  it('rejects a replacement and keeps serving the first service', async () => {
    fx = createOwnerFixture()
    const { controller, service } = await attached()
    expect(() => controller.attach(fx.service())).toThrow()
    expect(controller.service()).toBe(service)
  })

  it('stops the attached service once however often it is stopped', async () => {
    fx = createOwnerFixture()
    const { controller, service } = await attached()
    const first = controller.stopForgeInboxService()
    const second = controller.stopForgeInboxService()
    expect(second).toBe(first)
    await first
    await expect(controller.stopForgeInboxService()).resolves.toBeUndefined()
    expect(service.status().running).toBe(false)
  })

  it('stopping with nothing attached resolves', async () => {
    fx = createOwnerFixture()
    await expect(new RuntimeForgeInboxController().stopForgeInboxService()).resolves.toBeUndefined()
  })

  describe('keeps the host busy', () => {
    it('while the listener is enabled, even when its port is taken', async () => {
      fx = createOwnerFixture()
      const held = await holdPort()
      const { controller, service } = await attached()
      try {
        await provision(service, listenerOn(held.port))
        expect(service.status().listener).toMatchObject({ enabled: true, listening: false })
        expect(controller.keepsHostBusy()).toBe(true)
      } finally {
        await held.release()
      }
    })

    it('not once the only work is finished history', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached()
      await provision(service, listenerOn(port))
      await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
      await vi.waitFor(() => expect(fx.deliveries()).toMatchObject([{ state: 'done' }]))
      await service.updateConfig(service.getConfig().configRevision, ownerConfig(DISABLED(port)))
      await service.settled()

      expect(service.status().listener.enabled).toBe(false)
      expect(controller.keepsHostBusy()).toBe(false)
    })

    it('while a retry is waiting for its next attempt with nothing draining', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const unavailable = { fetch: async () => new Response('{}', { status: 503 }) }
      const { controller, service } = await attached({ http: unavailable })
      await provision(service, listenerOn(port))
      await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
      await vi.waitFor(() => expect(fx.deliveries()).toMatchObject([{ attempts: 1 }]))
      await service.settled()
      await service.updateConfig(service.getConfig().configRevision, ownerConfig(DISABLED(port)))
      await service.settled()

      const { work } = service.status()
      expect(work).toMatchObject({ pending: 1, draining: false })
      expect(work.nextAttemptAtMs).toBeGreaterThan(Date.now())
      expect(controller.keepsHostBusy()).toBe(true)
    })

    it('not for rows parked on a missing credential', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached()
      await provision(service, listenerOn(port), { apiRead: null })
      await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
      await vi.waitFor(() => expect(service.status().work.needsAuth).toBe(1))
      await service.settled()
      await service.updateConfig(service.getConfig().configRevision, ownerConfig(DISABLED(port)))
      await service.settled()

      expect(service.status().work.needsAuth).toBe(1)
      expect(controller.keepsHostBusy()).toBe(false)
    })

    it('not for a delivery that failed for good', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached()
      await provision(service, listenerOn(port))
      await postHook(
        port,
        { ...mergeRequestHookBody({ reviewers: ['me'] }), object_kind: 'bogus' },
        'm-1'
      )
      await vi.waitFor(() => expect(fx.deliveries()).toMatchObject([{ state: 'failed' }]))
      await service.updateConfig(service.getConfig().configRevision, ownerConfig(DISABLED(port)))
      await service.settled()

      expect(controller.keepsHostBusy()).toBe(false)
    })

    it('not while the service is dormant with no ledger', async () => {
      fx = createOwnerFixture()
      const { controller } = await attached()
      expect(controller.keepsHostBusy()).toBe(false)
      await controller.stopForgeInboxService()
      expect(existsSync(fx.dbPath)).toBe(false)
    })

    it('not once stopped', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached()
      await provision(service, listenerOn(port))
      expect(controller.keepsHostBusy()).toBe(true)
      await controller.stopForgeInboxService()
      expect(controller.keepsHostBusy()).toBe(false)
    })
  })
})
