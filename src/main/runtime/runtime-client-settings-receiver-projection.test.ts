import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { getDefaultPersistedState } from '../../shared/constants'
import { updateSettings } from '../persistence/applying-settings/settings-update'
import { SettingsUpdate } from '../../shared/rpc-contract/client-settings-params'
import { DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS } from '../../shared/project-event-receiver-settings'

const receiver = {
  ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
  enabled: true,
  port: 8123,
  externalBaseUrl: 'https://events.example.test'
}

describe('paired receiver settings', () => {
  it('accepts an exact receiver update and rejects invalid ports and unacknowledged exposure', () => {
    expect(SettingsUpdate.safeParse({ projectEventReceiver: receiver }).success).toBe(true)
    expect(
      SettingsUpdate.safeParse({ projectEventReceiver: { ...receiver, port: 0 } }).success
    ).toBe(false)
    expect(
      SettingsUpdate.safeParse({ projectEventReceiver: { ...receiver, bindAddress: '0.0.0.0' } })
        .success
    ).toBe(false)
  })

  it('projects the saved host receiver and supplies disabled defaults on a new host', async () => {
    const state = getDefaultPersistedState('/w')
    delete state.settings.projectEventReceiver
    const controller = new RuntimeClientSettingsController({
      getSettings: () => state.settings,
      updateSettings: (updates, options) =>
        updateSettings(
          {
            state,
            bumpLocalWorktreeScanGeneration: () => {},
            removeRetainedBlob: () => {},
            scheduleSave: () => {},
            notifySettingsChanged: () => {}
          },
          updates,
          options
        )
    })
    expect(controller.get()).toHaveProperty(
      'projectEventReceiver',
      DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS
    )
    await controller.update({ projectEventReceiver: receiver })
    expect(controller.get()).toHaveProperty('projectEventReceiver', receiver)
    expect(state.settings.projectEventReceiver).toEqual(receiver)
    await expect(
      controller.update({ projectEventReceiver: { ...receiver, port: 0 } })
    ).rejects.toThrow('Invalid project event receiver settings')
    expect(state.settings.projectEventReceiver).toEqual(receiver)
  })
})
