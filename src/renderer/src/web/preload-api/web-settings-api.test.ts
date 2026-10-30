// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from 'vitest'
import type { ProjectEventReceiverSettings } from '../../../../shared/project-event-receiver-settings'

type Session = {
  state: Record<string, unknown>
  environment: { id: string; createdAt: number } | null
}

const runtime = vi.hoisted(() => ({ call: vi.fn() }))
const session = vi.hoisted((): Session => ({
  state: {},
  environment: { id: 'env-1', createdAt: 1 }
}))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => session.environment,
  resolveEnvironment: (id: string) => ({ id }),
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
    window.localStorage.setItem(key, JSON.stringify(value)),
  noopUnsubscribe: () => {}
}))

import { getStoredSettings } from './web-preferences-store'
import { createWebSettingsApi } from './web-settings-api'

const HOST_RECEIVER: ProjectEventReceiverSettings = {
  enabled: true,
  bindAddress: '127.0.0.1',
  port: 8123,
  externalBaseUrl: 'https://events.example.test',
  acknowledgeExternalPlaintextHttp: false
}
const SENT_RECEIVER: ProjectEventReceiverSettings = { ...HOST_RECEIVER, port: 9000 }

function settingsApi() {
  const api = createWebSettingsApi()
  if (!api.settings) {
    throw new Error('settings api missing')
  }
  return api.settings
}

beforeEach(() => {
  window.localStorage.clear()
  runtime.call.mockReset()
  session.environment = { id: 'env-1', createdAt: 1 }
})

it('does not leave a rejected receiver in the local mirror', async () => {
  runtime.call.mockRejectedValue(new Error('host rejected settings'))
  const before = getStoredSettings().projectEventReceiver

  await expect(settingsApi().set({ projectEventReceiver: SENT_RECEIVER })).rejects.toThrow(
    'host rejected settings'
  )
  expect(getStoredSettings().projectEventReceiver).toEqual(before)
})

it('stores the host-returned receiver after a successful write', async () => {
  runtime.call.mockResolvedValue({ settings: { projectEventReceiver: HOST_RECEIVER } })

  const result = await settingsApi().set({ projectEventReceiver: SENT_RECEIVER })

  expect(runtime.call).toHaveBeenCalledWith(
    'settings.update',
    { projectEventReceiver: SENT_RECEIVER },
    15_000
  )
  expect(result.projectEventReceiver).toEqual(HOST_RECEIVER)
  expect(getStoredSettings().projectEventReceiver).toEqual(HOST_RECEIVER)
})

it('keeps local receiver persistence when no runtime environment is active', async () => {
  session.environment = null

  const result = await settingsApi().set({ projectEventReceiver: SENT_RECEIVER })

  expect(runtime.call).not.toHaveBeenCalled()
  expect(result.projectEventReceiver).toEqual(SENT_RECEIVER)
  expect(getStoredSettings().projectEventReceiver).toEqual(SENT_RECEIVER)
})
