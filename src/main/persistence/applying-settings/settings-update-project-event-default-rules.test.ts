import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { DEFAULT_PROJECT_EVENT_RULES } from '../../../shared/project-event-default-rules'
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

describe('global project event default rules writes', () => {
  it('stores an edited template verbatim', () => {
    const ops = operations()
    updateSettings(ops, { projectEventDefaultRules: '先读 diff，再决定。' })
    expect(ops.state.settings.projectEventDefaultRules).toBe('先读 diff，再决定。')
    expect(ops.scheduleSave).toHaveBeenCalled()
  })

  it.each([
    { reason: 'oversized', value: 'a'.repeat(16 * 1024 + 1) },
    { reason: 'nul', value: '规则一\u0000规则二' }
  ])('clamps an invalid $reason template back to the shipped one', ({ value }) => {
    const ops = operations()
    updateSettings(ops, { projectEventDefaultRules: value })
    expect(ops.state.settings.projectEventDefaultRules).toBe(DEFAULT_PROJECT_EVENT_RULES)
  })

  it('does not touch unrelated settings when the field is absent', () => {
    const ops = operations()
    updateSettings(ops, { machineName: 'mac-mini' })
    expect(ops.state.settings.projectEventDefaultRules).toBeUndefined()
  })
})
