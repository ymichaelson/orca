import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS } from '../../shared/project-event-receiver-settings'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import {
  connectRefused,
  createOwnerFixture,
  freePort,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import { projectEventReceiverSettingsForStore } from './project-event-receiver-settings-source'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('profile receiver settings source', () => {
  let fx: OwnerFixture

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-receiver-store-'))
    fx = createOwnerFixture()
  })

  afterEach(async () => {
    await fx.dispose()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('drives real socket lifecycle from durable profile settings without explicit reconciliation', async () => {
    const store = createStore()
    const source = projectEventReceiverSettingsForStore(store)
    const service = fx.service({ receiverSettings: source })
    let receiverChanges = 0
    const unsubscribe = source.subscribe(() => {
      receiverChanges++
    })
    await service.start()
    const port = await freePort()
    const settings = { ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS, enabled: true, port }

    await store.updateSettingsAndFlush(
      { projectEventReceiver: settings },
      { notifyListeners: true }
    )
    await vi.waitFor(() => {
      expect(service.status().listener).toMatchObject({ listening: true, port })
    })
    expect(await connectRefused(port)).toBe(false)
    store.updateSettings({ machineName: 'receiver-test-host' }, { notifyListeners: true })
    expect(receiverChanges).toBe(1)
    expect(service.status().listener).toMatchObject({ listening: true, port })

    unsubscribe()
    await store.updateSettingsAndFlush(
      {
        projectEventReceiver: { ...settings, externalBaseUrl: 'https://receiver.example.com' }
      },
      { notifyListeners: true }
    )
    expect(receiverChanges).toBe(1)
    await service.stop()
    expect(await connectRefused(port)).toBe(true)
    await closeTestStores()
    const reopened = createStore()
    const restarted = fx.service({
      receiverSettings: projectEventReceiverSettingsForStore(reopened)
    })
    await restarted.start()
    expect(restarted.status().listener).toMatchObject({ listening: true, port })
    await reopened.updateSettingsAndFlush(
      {
        projectEventReceiver: { ...settings, enabled: false }
      },
      { notifyListeners: true }
    )
    await vi.waitFor(() => {
      expect(restarted.status().listener).toMatchObject({ enabled: false, listening: false })
    })
    expect(await connectRefused(port)).toBe(true)
    expect(receiverChanges).toBe(1)
    expect(service.status().running).toBe(false)
  })
})
