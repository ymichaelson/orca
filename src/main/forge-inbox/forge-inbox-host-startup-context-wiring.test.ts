import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createOwnerFixture,
  freePort,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import type { ForgeInboxOwnerService } from './forge-inbox-owner-service'
import { startForgeInboxForHost } from './forge-inbox-host-startup'

const { contextObserverFactory } = vi.hoisted(() => ({
  contextObserverFactory: vi.fn((_ledger: ForgeInboxLedger) => async () => ({
    ok: false,
    code: 'aborted'
  }))
}))

vi.mock('./forge-inbox-project-event-context-observer', () => ({
  createForgeProjectEventContextObserver: contextObserverFactory
}))

describe('forge inbox host startup context wiring', () => {
  let fx: OwnerFixture | undefined
  const started: ForgeInboxOwnerService[] = []

  afterEach(async () => {
    for (const service of started.splice(0)) {
      await service.stop().catch(() => undefined)
    }
    await fx?.dispose()
    fx = undefined
    contextObserverFactory.mockClear()
  })

  it('hands the opened ledger to the context observer factory', async () => {
    fx = createOwnerFixture()
    const port = await freePort()

    const startedHost = await startForgeInboxForHost({
      profileDirectory: fx.root,
      receiverSettings: fx.receiverSettings,
      secretStore: fx.store,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: (service) => {
        started.push(service)
      }
    })
    expect(startedHost).toEqual({ started: true })
    expect(contextObserverFactory).not.toHaveBeenCalled()

    const [service] = started
    if (!service) {
      throw new Error('expected the host to attach a service')
    }
    await fx.provision(service, { enabled: false, bindAddress: '127.0.0.1', port })

    expect(contextObserverFactory).toHaveBeenCalledTimes(1)
    expect(contextObserverFactory.mock.calls[0]?.[0]).toBeInstanceOf(ForgeInboxLedger)
  })
})
