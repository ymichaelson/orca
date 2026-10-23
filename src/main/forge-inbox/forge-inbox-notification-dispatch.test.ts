import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../runtime/runtime-mobile-notification-controller'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { startForgeInboxForHost } from './forge-inbox-host-startup'
import type { ForgeInboxOwnerService } from './forge-inbox-owner-service'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'

describe('forge inbox notifications through the host startup port', () => {
  let fx: OwnerFixture
  const services: ForgeInboxOwnerService[] = []
  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.stop()
    }
    await fx.dispose()
  })

  it('reaches the runtime controller as a typed Forge event with a per-item attention key', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await provision(seed, listenerOn(port))
    await seed.stop()
    const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
    const pending = [
      { kind: 'merge_request', iid: 7, category: 'review-request' },
      { kind: 'issue', iid: 3, category: 'issue-assignment' }
    ] as const
    for (const [index, entry] of pending.entries()) {
      ledger.ingestEvent({
        hostId: ledger.hostId,
        instanceId: INSTANCE_ID,
        projectId: PROJECT_ID,
        kind: entry.kind,
        iid: entry.iid,
        dedupeKey: `seed-${index}`,
        eventKind: 'gitlab.seed',
        payload: { category: entry.category, passive: false },
        versionToken: `ctx-${index}`,
        sourceOrder: index + 1,
        title: 'Add thing'
      })
    }
    ledger.close()

    const controller = new RuntimeMobileNotificationController()
    const events: MobileNotificationEvent[] = []
    controller.onDispatched((event) => events.push(event))
    await startForgeInboxForHost({
      profileDirectory: fx.root,
      http: fx.gate.http,
      networkReady: Promise.resolve(),
      attach: (service) => services.push(service),
      notify: (event) => controller.dispatch(event)
    })
    const service = services[0]

    const forgeEvents = () =>
      events.flatMap((event) =>
        event.type === 'notification' && event.source === 'forge-inbox' ? [event] : []
      )
    await vi.waitFor(() => expect(forgeEvents()).toHaveLength(2))
    const forge = forgeEvents()
    expect(forge.map((event) => event.forgeInbox?.reason).toSorted()).toEqual([
      'issue-assignment',
      'review-request'
    ])
    for (const event of forge) {
      expect(event.forgeInbox?.ownerId).toBe(service.ownerHostId())
      expect(event.executionHost).toBeUndefined()
      expect(event.worktreeId).toBeUndefined()
      expect(event.attentionKey).toBe(
        `forge-inbox:${service.ownerHostId()}:${event.forgeInbox?.instanceId}:${event.forgeInbox?.itemId}`
      )
      expect(event.notificationId).not.toBe(event.attentionKey)
      expect(`${event.title} ${event.body}`).not.toMatch(/https?:|Add thing|glpat/)
    }
    expect(new Set(forge.map((event) => event.notificationId)).size).toBe(2)
    expect(new Set(forge.map((event) => event.attentionKey)).size).toBe(2)
  })
})
