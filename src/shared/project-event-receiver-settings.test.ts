import { describe, expect, it } from 'vitest'
import { FORGE_INBOX_DEFAULT_PORT } from './forge-inbox-config'
import {
  DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
  normalizeProjectEventReceiverSettings,
  receiverBaseUrl
} from './project-event-receiver-settings'

describe('receiverBaseUrl', () => {
  it('derives the canonical base URL', () => {
    expect(
      receiverBaseUrl({
        ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
        externalBaseUrl: 'https://orca.example.com/'
      })
    ).toBe('https://orca.example.com')
  })

  it('is null when externalBaseUrl is empty', () => {
    expect(receiverBaseUrl(DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS)).toBeNull()
  })

  it('is null when externalBaseUrl is an unspecified bind address', () => {
    expect(
      receiverBaseUrl({
        ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
        externalBaseUrl: 'http://0.0.0.0:7421'
      })
    ).toBeNull()
  })
})

describe('normalizeProjectEventReceiverSettings', () => {
  it('returns defaults for undefined or non-object input', () => {
    expect(normalizeProjectEventReceiverSettings(undefined)).toEqual(
      DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS
    )
    expect(normalizeProjectEventReceiverSettings(null)).toEqual(
      DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS
    )
    expect(normalizeProjectEventReceiverSettings('nope')).toEqual(
      DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS
    )
  })

  it('passes through a valid object and canonicalizes externalBaseUrl', () => {
    expect(
      normalizeProjectEventReceiverSettings({
        enabled: true,
        bindAddress: '127.0.0.1',
        port: 7421,
        externalBaseUrl: 'https://orca.example.com/path/',
        acknowledgeExternalPlaintextHttp: true
      })
    ).toEqual({
      enabled: true,
      bindAddress: '127.0.0.1',
      port: 7421,
      externalBaseUrl: 'https://orca.example.com/path',
      acknowledgeExternalPlaintextHttp: true
    })
  })

  it('clamps invalid fields to safe defaults', () => {
    expect(
      normalizeProjectEventReceiverSettings({
        enabled: 'yes',
        bindAddress: 'not-an-ip',
        port: 70000,
        externalBaseUrl: 'http://0.0.0.0:7421',
        acknowledgeExternalPlaintextHttp: 1
      })
    ).toEqual({
      enabled: false,
      bindAddress: '127.0.0.1',
      port: FORGE_INBOX_DEFAULT_PORT,
      externalBaseUrl: '',
      acknowledgeExternalPlaintextHttp: false
    })
  })

  it('accepts an IPv6 bind address and drops a credential-bearing externalBaseUrl', () => {
    expect(
      normalizeProjectEventReceiverSettings({
        enabled: true,
        bindAddress: '::1',
        port: 8080,
        externalBaseUrl: 'https://user:pass@example.com',
        acknowledgeExternalPlaintextHttp: false
      })
    ).toEqual({
      enabled: true,
      bindAddress: '::1',
      port: 8080,
      externalBaseUrl: '',
      acknowledgeExternalPlaintextHttp: false
    })
  })
})
