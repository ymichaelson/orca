import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from '../forge-inbox/forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  holdPort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import { RuntimeForgeInboxController } from './runtime-forge-inbox-controller'

const decided = (action: 'record_only' | 'ask_user'): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action,
  confidence: 0.8,
  probabilities: {
    record_only: action === 'record_only' ? 0.8 : 0.04,
    notify: 0.04,
    wait: 0.04,
    fetch_context: 0.04,
    dispatch_agent: 0.04,
    ask_user: action === 'ask_user' ? 0.8 : 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
})

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
        await fx.configureReceiver(service, listenerOn(held.port))
        expect(service.status().listener).toMatchObject({ enabled: true, listening: false })
        expect(controller.keepsHostBusy()).toBe(true)
      } finally {
        await held.release()
      }
    })

    it('not once the only work is finished history', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached({
        decideProjectEvent: async () => decided('record_only')
      })
      await fx.provision(service, listenerOn(port))
      await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
      await vi.waitFor(() =>
        expect(fx.rows('SELECT action_state FROM project_event_decisions')).toEqual([
          { action_state: 'done' }
        ])
      )
      await fx.configureReceiver(service, { ...listenerOn(port), enabled: false })
      await service.settled()

      expect(service.status().listener.enabled).toBe(false)
      expect(controller.keepsHostBusy()).toBe(false)
    })

    it('not while an action waits for the user to answer', async () => {
      fx = createOwnerFixture()
      const port = await freePort()
      const { controller, service } = await attached({
        decideProjectEvent: async () => decided('ask_user')
      })
      await fx.provision(service, listenerOn(port))
      await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
      await vi.waitFor(() =>
        expect(
          fx.rows('SELECT action_state, last_error_code FROM project_event_decisions')
        ).toEqual([{ action_state: 'blocked', last_error_code: 'awaiting-user' }])
      )
      await fx.configureReceiver(service, { ...listenerOn(port), enabled: false })
      await service.settled()

      expect(service.status().work).toMatchObject({ pending: 0, draining: false })
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
      await fx.configureReceiver(service, listenerOn(port))
      expect(controller.keepsHostBusy()).toBe(true)
      await controller.stopForgeInboxService()
      expect(controller.keepsHostBusy()).toBe(false)
    })
  })
})
