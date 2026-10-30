import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { PROTECTED_SECRET_SLOT } from '../protected-secret-persistence'
import { RuntimeClientSettingsController } from './runtime-client-settings'

describe('paired decision key projection', () => {
  // Why: a key whose ciphertext survived a keyring failure cannot be used, but the client must
  // still be able to offer Clear — otherwise the stored secret could never be removed.
  it('reports a stored but unreadable key as sealed instead of saved', () => {
    const state = getDefaultPersistedState('/w')
    state.settings.projectEventDecisionKey = ''
    const sealed = new Set<string>([PROTECTED_SECRET_SLOT.projectEventDecisionKey])
    const controller = new RuntimeClientSettingsController({
      getSettings: () => state.settings,
      hasSealedProtectedSecret: (slot) => sealed.has(slot)
    })
    expect(controller.getDecisionSettings()).toMatchObject({
      apiKeysSaved: { jev: false, laya: false },
      apiKeysSealed: { jev: true, laya: false }
    })
    expect(controller.get().projectEventDecision).toMatchObject({
      apiKeysSealed: { jev: true, laya: false }
    })
  })

  it('reports no sealed key for a host that never retained one', () => {
    const state = getDefaultPersistedState('/w')
    const controller = new RuntimeClientSettingsController({
      getSettings: () => state.settings
    })
    expect(controller.getDecisionSettings().apiKeysSealed).toEqual({ jev: false, laya: false })
  })
})
