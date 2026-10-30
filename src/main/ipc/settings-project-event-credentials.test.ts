import { describe, expect, it, beforeEach } from 'vitest'
import { handleMock, onMock, store, resetSettingsIpcTestFixture } from './settings-ipc-test-fixture'
import { registerSettingsHandlers } from './settings'

describe('project event settings credentials', () => {
  beforeEach(resetSettingsIpcTestFixture)

  it('keeps both decision keys on the host for async and sync settings reads', () => {
    store.getSettings.mockReturnValue({
      projectEventDecisionKey: 'host-only-key',
      projectEventDecisionLayaKey: 'host-only-laya-key',
      uiLanguage: 'en'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The read handlers only need the fixture settings methods.
    registerSettingsHandlers(store as never)
    const get = handleMock.mock.calls.find(([channel]) => channel === 'settings:get')?.[1]
    const getSync = onMock.mock.calls.find(([channel]) => channel === 'settings:get-sync')?.[1]
    expect(get()).toEqual({ uiLanguage: 'en' })
    const event = { returnValue: undefined }
    getSync(event)
    expect(event.returnValue).toEqual({ uiLanguage: 'en' })
    expect(store.getSettings().projectEventDecisionKey).toBe('host-only-key')
  })

  it('does not accept decision credentials through generic settings updates', async () => {
    store.getSettings.mockReturnValue({ uiLanguage: 'en' })
    store.updateSettings.mockReturnValue({ uiLanguage: 'en' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The update handler only needs the fixture settings methods.
    registerSettingsHandlers(store as never)
    const update = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
    await update(
      { sender: { id: 1 } },
      { projectEventDecisionKey: 'must-not-write', uiLanguage: 'en' }
    )
    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectEventDecisionKey: expect.anything() }),
      expect.anything()
    )
    await update(
      { sender: { id: 1 } },
      { projectEventDecisionLayaKey: 'must-not-write', uiLanguage: 'en' }
    )
    expect(store.updateSettings).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ projectEventDecisionLayaKey: expect.anything() }),
      expect.anything()
    )
  })
})
