import { describe, expect, it } from 'vitest'
import { canonicalReceiverBaseUrl } from './forge-inbox-config'

describe('canonicalReceiverBaseUrl', () => {
  it.each([
    ['https://orca.example.com', 'https://orca.example.com'],
    ['https://orca.example.com/', 'https://orca.example.com'],
    ['https://orca.example.com/base/path/', 'https://orca.example.com/base/path'],
    ['http://192.168.1.10:7421', 'http://192.168.1.10:7421'],
    ['https://[2001:db8::1]:7421/prefix', 'https://[2001:db8::1]:7421/prefix']
  ])('canonicalizes %s to %s', (value, expected) => {
    expect(canonicalReceiverBaseUrl(value)).toBe(expected)
  })

  it.each([
    'http://0.0.0.0:7421',
    'http://0.0.0.0',
    'https://[::]:7421',
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:0]:7421',
    'ftp://example.com',
    'https://user@example.com',
    'https://:pass@example.com',
    'https://user:pass@example.com',
    'https://example.com/path with space',
    'https://example.com/path?query=1',
    'https://example.com/path#frag',
    'https://example.com\\path',
    'not a url',
    '',
    'https://'
  ])('rejects %j', (value) => {
    expect(canonicalReceiverBaseUrl(value)).toBeNull()
  })
})
