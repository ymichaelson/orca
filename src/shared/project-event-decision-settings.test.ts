import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_EVENT_DECISION_SETTINGS,
  decisionApiKeyForProvider,
  normalizeProjectEventDecisionSettings,
  projectEventDecisionSettingsView,
  parseProjectEventDecisionSettings
} from './project-event-decision-settings'

describe('project event decision settings', () => {
  it('drops a base URL that is not a URL and ignores a key carried in the object', () => {
    expect(
      normalizeProjectEventDecisionSettings({
        provider: 'laya',
        apiKey: 'not a key',
        model: 'local',
        baseUrl: 'not a url'
      })
    ).toEqual({ provider: 'laya', model: 'local', baseUrl: '' })
  })

  it('preserves the configured Laya API path', () => {
    expect(
      parseProjectEventDecisionSettings({
        provider: 'laya',
        model: 'local',
        baseUrl: 'https://laya.example/api/'
      }).baseUrl
    ).toBe('https://laya.example/api/')
  })

  it.each([
    ' https://laya.example/api',
    'https://laya.example/api?token=value',
    'https://laya.example/api#fragment',
    'https://laya.example\\api'
  ])('rejects ambiguous or decorated endpoints: %s', (baseUrl) => {
    expect(() =>
      parseProjectEventDecisionSettings({
        provider: 'laya',
        model: 'local',
        baseUrl
      })
    ).toThrow('Invalid project event decision settings')
  })

  it('falls back to the default when the stored value is not an object', () => {
    expect(normalizeProjectEventDecisionSettings('jev')).toEqual(
      DEFAULT_PROJECT_EVENT_DECISION_SETTINGS
    )
  })

  it('reports which providers have a key saved without returning one', () => {
    expect(
      projectEventDecisionSettingsView(DEFAULT_PROJECT_EVENT_DECISION_SETTINGS, {
        projectEventDecisionKey: 'jev-key'
      })
    ).toEqual({
      provider: 'jev',
      model: '',
      baseUrl: '',
      apiKeysSaved: { jev: true, laya: false },
      apiKeysSealed: { jev: false, laya: false }
    })
  })

  it('reports a stored key this process cannot decrypt as sealed, not as saved', () => {
    const view = projectEventDecisionSettingsView(
      DEFAULT_PROJECT_EVENT_DECISION_SETTINGS,
      {},
      { jev: true }
    )
    expect(view.apiKeysSaved).toEqual({ jev: false, laya: false })
    expect(view.apiKeysSealed).toEqual({ jev: true, laya: false })
  })

  it('reports no sealed key when every stored key is readable', () => {
    expect(
      projectEventDecisionSettingsView(DEFAULT_PROJECT_EVENT_DECISION_SETTINGS, {
        projectEventDecisionLayaKey: 'laya-key'
      }).apiKeysSealed
    ).toEqual({ jev: false, laya: false })
  })

  it('never reads a key saved for the other provider', () => {
    const keys = { projectEventDecisionKey: 'jev-key', projectEventDecisionLayaKey: 'laya-key' }
    expect(decisionApiKeyForProvider('jev', keys)).toBe('jev-key')
    expect(decisionApiKeyForProvider('laya', keys)).toBe('laya-key')
    expect(decisionApiKeyForProvider('jev', { projectEventDecisionLayaKey: 'laya-key' })).toBe('')
  })
})
