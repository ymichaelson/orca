// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProjectEventReceiverSettings } from '../../../../shared/project-event-receiver-settings'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))
const session = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, environment: { id: 'env-1', createdAt: 1 } }
})
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => session.environment,
  webRuntimeState: session.state
}))
vi.mock('./web-storage', () => ({
  SETTINGS_STORAGE_KEY: 'orca.web.settings.v1',
  UI_STORAGE_KEY: 'orca.web.ui.v1',
  readJson: (key: string, fallback: object) => {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return fallback
    }
    try {
      return { ...fallback, ...JSON.parse(raw) }
    } catch {
      return fallback
    }
  },
  writeJson: (key: string, value: unknown) =>
    window.localStorage.setItem(key, JSON.stringify(value))
}))

import { getRuntimeBackedStoredSettings, syncRuntimeBackedSettings } from './web-preferences-store'

const HOST_RECEIVER: ProjectEventReceiverSettings = {
  enabled: true,
  bindAddress: '127.0.0.1',
  port: 8123,
  externalBaseUrl: 'https://events.example.test',
  acknowledgeExternalPlaintextHttp: false
}

beforeEach(() => {
  window.localStorage.clear()
  runtime.call.mockReset()
})

describe('web preferences bridge project event receiver', () => {
  it('merges the host receiver settings instead of the local default', async () => {
    runtime.call.mockResolvedValue({ settings: { projectEventReceiver: HOST_RECEIVER } })

    const settings = await getRuntimeBackedStoredSettings()

    expect(settings.projectEventReceiver).toEqual(HOST_RECEIVER)
  })

  it('tolerates receiver fields a newer host adds and keeps the known ones', async () => {
    runtime.call.mockResolvedValue({
      settings: { projectEventReceiver: { ...HOST_RECEIVER, futureFlag: true } }
    })

    const settings = await getRuntimeBackedStoredSettings()

    expect(settings.projectEventReceiver).toEqual(HOST_RECEIVER)
    expect(settings.projectEventReceiver).not.toHaveProperty('futureFlag')
  })

  it('forwards receiver updates through settings.update and returns the host value', async () => {
    const stored: ProjectEventReceiverSettings = { ...HOST_RECEIVER, port: 9000 }
    runtime.call.mockResolvedValue({ settings: { projectEventReceiver: stored } })
    const localNext = getDefaultSettings('/synthetic')

    const result = await syncRuntimeBackedSettings(
      { projectEventReceiver: HOST_RECEIVER },
      localNext
    )

    expect(runtime.call).toHaveBeenCalledWith(
      'settings.update',
      { projectEventReceiver: HOST_RECEIVER },
      15_000
    )
    expect(result.projectEventReceiver).toEqual(stored)
  })

  it('rejects instead of reporting a successful local save when the host write fails', async () => {
    runtime.call.mockRejectedValue(new Error('host rejected settings'))
    const localNext = getDefaultSettings('/synthetic')

    await expect(
      syncRuntimeBackedSettings({ projectEventReceiver: HOST_RECEIVER }, localNext)
    ).rejects.toThrow('host rejected settings')
  })

  it('still keeps local persistence for unrelated keys when the host write fails', async () => {
    runtime.call.mockRejectedValue(new Error('offline'))
    const localNext = getDefaultSettings('/synthetic')

    await expect(
      syncRuntimeBackedSettings({ compactWorktreeCards: true }, localNext)
    ).resolves.toBe(localNext)
  })
})
