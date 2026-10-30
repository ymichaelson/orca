import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secret-store'
import { PROTECTED_SECRET_SLOT } from '../../protected-secret-persistence'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function operations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these writes read only settings and repos.
    state: {
      settings: { projectEventDecisionKey: 'jev', projectEventDecisionLayaKey: 'laya' },
      repos: []
    } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

afterEach(() => _resetSecretStoreForTests())

describe('project event decision settings writes', () => {
  it('clears each retained key only after the settings are updated', () => {
    const ops = operations()
    const removed: string[] = []
    ops.removeRetainedBlob = (slot) => {
      expect(ops.state.settings.projectEventDecisionKey).toBe('')
      expect(ops.state.settings.projectEventDecisionLayaKey).toBe('')
      removed.push(slot)
    }
    updateSettings(ops, { projectEventDecisionKey: '', projectEventDecisionLayaKey: '' })
    expect(removed).toEqual([
      PROTECTED_SECRET_SLOT.projectEventDecisionKey,
      PROTECTED_SECRET_SLOT.projectEventDecisionLayaKey
    ])
    expect(ops.scheduleSave).toHaveBeenCalledOnce()
  })

  it('rejects malformed combined updates without clearing secrets or mutating state', () => {
    const ops = operations()
    const before = ops.state.settings
    expect(() =>
      updateSettings(
        ops,
        {
          projectEventDecisionKey: '',
          projectEventDecisionLayaKey: 'invalid key',
          machineName: 'not saved'
        },
        { notifyListeners: true }
      )
    ).toThrow('Invalid project event decision key')
    expect(ops.state.settings).toBe(before)
    expect(ops.removeRetainedBlob).not.toHaveBeenCalled()
    expect(ops.scheduleSave).not.toHaveBeenCalled()
    expect(ops.notifySettingsChanged).not.toHaveBeenCalled()
  })

  it('rejects nonempty keys when protected storage is unavailable', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => 'unprotected',
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    })
    const ops = operations()
    const before = ops.state.settings
    expect(() =>
      updateSettings(ops, { projectEventDecisionLayaKey: 'new-key', projectEventDecisionKey: '' })
    ).toThrow('Protected storage is unavailable for the project event decision key')
    expect(ops.state.settings).toBe(before)
    expect(ops.removeRetainedBlob).not.toHaveBeenCalled()
    expect(ops.scheduleSave).not.toHaveBeenCalled()
  })
})
