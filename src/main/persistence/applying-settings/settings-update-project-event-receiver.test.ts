import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS } from '../../../shared/project-event-receiver-settings'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function operations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only settings and repos are read for these writes.
    state: { settings: {}, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

const defaults = DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS

describe('global project event receiver writes', () => {
  it.each([
    { enabled: 'yes' },
    { bindAddress: 'localhost' },
    { port: 0 },
    { port: 65536 },
    { port: 12.5 },
    { externalBaseUrl: 'http://0.0.0.0:7421' },
    { externalBaseUrl: 'https://user:secret@example.com' },
    { externalBaseUrl: 'https://example.com/?secret=value' },
    { unexpected: true },
    { enabled: true, bindAddress: '0.0.0.0' },
    { enabled: true, externalBaseUrl: 'http://receiver.example.com' }
  ])('rejects invalid receiver input atomically: %j', (patch) => {
    const ops = operations()
    const before = ops.state.settings
    expect(() =>
      updateSettings(
        ops,
        {
          // @ts-expect-error Exercise malformed wire input at the shared write boundary.
          projectEventReceiver: { ...defaults, ...patch },
          httpProxyUrl: '',
          machineName: 'must-not-save'
        },
        { notifyListeners: true }
      )
    ).toThrow('Invalid project event receiver settings')
    expect(ops.state.settings).toBe(before)
    expect(ops.scheduleSave).not.toHaveBeenCalled()
    expect(ops.removeRetainedBlob).not.toHaveBeenCalled()
    expect(ops.notifySettingsChanged).not.toHaveBeenCalled()
  })

  it('saves acknowledged external HTTP and canonicalizes the callback base', () => {
    const ops = operations()
    const settings = updateSettings(
      ops,
      {
        projectEventReceiver: {
          ...defaults,
          enabled: true,
          bindAddress: '0.0.0.0',
          externalBaseUrl: 'https://orca.example.com/callback/',
          acknowledgeExternalPlaintextHttp: true
        }
      },
      { notifyListeners: true }
    )
    expect(settings.projectEventReceiver).toMatchObject({
      enabled: true,
      bindAddress: '0.0.0.0',
      externalBaseUrl: 'https://orca.example.com/callback'
    })
    expect(ops.notifySettingsChanged).toHaveBeenCalledWith(
      {
        projectEventReceiver: settings.projectEventReceiver
      },
      undefined
    )
  })
})
