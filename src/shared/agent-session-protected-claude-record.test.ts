import { describe, expect, it } from 'vitest'
import { foundAgentSessionRecord } from '../main/runtime/agent-session-record-founding'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from './agent-session-protected-claude-launch.test-fixture'

const LAUNCH = protectedClaudeLaunchFixture()
const IDENTITY = {
  ...agentSessionRecordFixture(),
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: `${LAUNCH.privateRoot}/config` },
  launchDirectory: '/fake/original-workspace',
  protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunch: LAUNCH,
  options: { model: 'opus' }
} as const

function protectedRow() {
  return {
    ...encodeAgentSessionRecord(agentSessionRecordFixture()),
    schemaVersion: 3,
    accountHome: IDENTITY.accountHome,
    protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
    protectedClaudeLaunch: LAUNCH,
    options: { model: 'opus' }
  }
}

const INVALID_LAUNCHES = [
  ['unknown profile', { ...LAUNCH, profile: 'claude-data-only-future' }],
  ['unknown version', { ...LAUNCH, version: 2 }],
  [
    'unknown platform',
    { ...LAUNCH, executable: { ...LAUNCH.executable, platform: 'linux-arm64' } }
  ],
  ['relative private root', { ...LAUNCH, privateRoot: 'private/session' }],
  ['extra token field', { ...LAUNCH, auth: { ...LAUNCH.auth, token: 'fake-never-persist-me' } }],
  [
    'unbound endpoint',
    { ...LAUNCH, auth: { ...LAUNCH.auth, baseUrl: 'https://api.test/?token=fake' } }
  ],
  [
    'URL credentials',
    { ...LAUNCH, auth: { ...LAUNCH.auth, baseUrl: 'https://user:fake@api.test' } }
  ],
  ['unknown source', { ...LAUNCH, auth: { kind: 'ambient-environment' } }],
  ['wrong settings slot', { ...LAUNCH, auth: { ...LAUNCH.auth, settingsKey: 'codex' } }],
  [
    'unknown credential key',
    { ...LAUNCH, auth: { ...LAUNCH.auth, credentialKey: 'GITLAB_TOKEN' } }
  ],
  ['noncanonical digest', { ...LAUNCH, executable: { ...LAUNCH.executable, sha256: 'ABC' } }]
] as const

describe('durable protected Claude launch identity', () => {
  it.each([undefined, '', ' ', 'x'.repeat(257)])(
    'requires an explicit bounded founding model: %s',
    (model) => {
      expect(
        isPersistedAgentSessionRecord({
          ...protectedRow(),
          options: model === undefined ? undefined : { model }
        })
      ).toBe(false)
    }
  )

  it('founds and round-trips the no-secret launch reference without changing workspace context', () => {
    const record = foundAgentSessionRecord(IDENTITY, { claimKeyId: 'key-1', now: 100 })
    expect(record).toMatchObject({
      schemaVersion: 3,
      protectedClaudeLaunch: LAUNCH,
      accountHome: IDENTITY.accountHome,
      launchDirectory: IDENTITY.launchDirectory,
      location: IDENTITY.location
    })
    const row: unknown = JSON.parse(JSON.stringify(encodeAgentSessionRecord(record)))
    expect(isPersistedAgentSessionRecord(row)).toBe(true)
    if (!isPersistedAgentSessionRecord(row)) {
      throw new Error('Invalid founding row')
    }
    expect(decodePersistedAgentSessionRecord(row).record).toMatchObject({
      protectedClaudeLaunch: LAUNCH
    })
    expect(JSON.stringify(row)).not.toContain('fake-never-persist-me')
  })

  it('continues reading 4a marker-only records without granting a launch reference', () => {
    const { protectedClaudeLaunch: _launch, ...row } = protectedRow()
    expect(isPersistedAgentSessionRecord(row)).toBe(true)
  })

  it('rejects a launch reference on an ordinary record', () => {
    expect(
      isPersistedAgentSessionRecord({
        ...encodeAgentSessionRecord(agentSessionRecordFixture()),
        protectedClaudeLaunch: LAUNCH
      })
    ).toBe(false)
  })

  it('rejects a non-Claude protected record carrying Claude launch authority', () => {
    const { protectedClaudeLaunch: _launch, ...identity } = IDENTITY
    const record = foundAgentSessionRecord(
      { ...identity, provider: 'codex' },
      { claimKeyId: 'key-1', now: 100 }
    )
    const row = encodeAgentSessionRecord(record)
    expect(isPersistedAgentSessionRecord(row)).toBe(true)
    expect(isPersistedAgentSessionRecord({ ...row, protectedClaudeLaunch: LAUNCH })).toBe(false)
  })

  it('rejects accountHome outside the immutable private namespace', () => {
    expect(
      isPersistedAgentSessionRecord({
        ...protectedRow(),
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fake/ordinary/.claude' }
      })
    ).toBe(false)
  })

  it.each(INVALID_LAUNCHES)('rejects %s before a stored row is accepted', (_name, launch) => {
    expect(
      isPersistedAgentSessionRecord({ ...protectedRow(), protectedClaudeLaunch: launch })
    ).toBe(false)
  })
})
