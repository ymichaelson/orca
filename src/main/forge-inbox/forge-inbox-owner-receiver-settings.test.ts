import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { createReceiverSettingsFixture as receiverSource } from '../project-events/project-event-receiver-settings-test-fixture'
import {
  connectRefused,
  createOwnerFixture,
  freePort,
  holdPort,
  holdRequestMidBody,
  listenerOn,
  ownerConfig,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

describe('owner listener uses global receiver settings', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('does not use the retired ledger listener when no global receiver is enabled', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const receiver = receiverSource()
    const service = fx.service({ receiverSettings: receiver })
    await service.start()
    await service.updateConfig(0, ownerConfig(listenerOn(port)))

    expect(service.status().listener).toMatchObject({ enabled: false, listening: false })
    expect(await connectRefused(port)).toBe(true)
  })

  it('opens a fresh ledger when enabled globally, follows settings changes, and unsubscribes on stop', async () => {
    fx = createOwnerFixture()
    const first = await freePort()
    const second = await freePort()
    const receiver = receiverSource()
    receiver.update({ enabled: true, port: first })
    const service = fx.service({ receiverSettings: receiver })
    await service.start()

    expect(existsSync(fx.dbPath)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: first })
    receiver.update({ port: second })
    await service.reconcileReceiverSettings()
    expect(await connectRefused(first)).toBe(true)
    expect(service.status().listener).toMatchObject({ listening: true, port: second })

    receiver.update({ enabled: false })
    await service.reconcileReceiverSettings()
    expect(await connectRefused(second)).toBe(true)
    expect(service.status().listener).toMatchObject({ enabled: false, listening: false })
    await service.stop()
    expect(receiver.subscriptions()).toBe(0)
    receiver.update({ enabled: true, port: first })
    expect(await connectRefused(first)).toBe(true)
  })

  it('stays dormant while disabled but wakes on a global enable without a config write', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const receiver = receiverSource()
    const service = fx.service({ receiverSettings: receiver })
    await service.start()
    expect(existsSync(fx.dbPath)).toBe(false)

    receiver.update({ enabled: true, port })
    await service.reconcileReceiverSettings()
    expect(service.status().listener).toMatchObject({ listening: true, port })
    await service.stop()
    expect(await connectRefused(port)).toBe(true)
  })

  it('refuses external plaintext binding without acknowledgement even from hand-edited settings', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const receiver = receiverSource()
    receiver.update({ enabled: true, bindAddress: '0.0.0.0', port })
    const service = fx.service({ receiverSettings: receiver })
    await service.start()
    expect(service.status().listener).toMatchObject({
      enabled: true,
      listening: false,
      error: 'external-plaintext-not-acknowledged'
    })
    expect(await connectRefused(port)).toBe(true)
    receiver.update({ bindAddress: '127.0.0.1' })
    await service.reconcileReceiverSettings()
    expect(service.status().listener).toMatchObject({ listening: true, port, error: null })
  })

  it('requires acknowledgement for an external HTTP proxy even when bound to loopback', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const receiver = receiverSource()
    receiver.update({ enabled: true, port, externalBaseUrl: 'http://receiver.example.com' })
    const service = fx.service({ receiverSettings: receiver })
    await service.start()
    expect(service.status().listener).toMatchObject({
      enabled: true,
      listening: false,
      error: 'external-plaintext-not-acknowledged'
    })
    expect(await connectRefused(port)).toBe(true)
    receiver.update({ externalBaseUrl: 'https://receiver.example.com' })
    await service.reconcileReceiverSettings()
    expect(service.status().listener).toMatchObject({ listening: true, port, error: null })
  })

  it('rejects a held authenticated body completed during global disable', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service({ ingress: { shutdownGraceMs: 5000 } })
    await service.start()
    await fx.provision(service, listenerOn(port))
    const held = await holdRequestMidBody(
      port,
      'held-on-disable',
      JSON.stringify(mergeRequestHookBody())
    )
    try {
      const disabling = fx.configureReceiver(service, { ...listenerOn(port), enabled: false })
      await vi.waitFor(() => expect(service.status().listener.enabled).toBe(false))
      const response = await held.finish()
      await disabling
      expect(response).toContain('HTTP/1.1 503')
      expect(fx.deliveries()).toEqual([])
      await service.settled()
      expect(fx.items()).toEqual([])
      expect(fx.gitlab.requests).toHaveLength(0)
    } finally {
      held.release()
    }
  })

  it('retains a bind failure and retries the exact configured port on explicit reconcile', async () => {
    fx = createOwnerFixture()
    const occupied = await holdPort()
    try {
      const receiver = receiverSource()
      receiver.update({ enabled: true, port: occupied.port })
      const service = fx.service({ receiverSettings: receiver })
      await service.start()
      expect(service.status().listener).toEqual({
        enabled: true,
        listening: false,
        port: null,
        error: 'EADDRINUSE'
      })
      await occupied.release()
      await service.reconcileReceiverSettings()
      expect(service.status().listener).toMatchObject({ listening: true, port: occupied.port })
    } finally {
      await occupied.release()
    }
  })
})
