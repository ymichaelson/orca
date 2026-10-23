import { describe, expect, it } from 'vitest'
import { foundAgentSessionRecord } from '../main/runtime/agent-session-record-founding'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionExecutionLocation
} from './agent-session-record'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'

const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

const IDENTITY = {
  sessionId: 'session-alpha',
  location: LOCATION,
  provider: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' }
} as const

const MARKER = {
  ownerId: '0b8f2c1e-5a3d-4f6b-9c7e-1d2a3b4c5d6e',
  instanceId: 'instance-1',
  itemId: '101',
  analysisKind: 'merge_request'
} as const

const LEASE = { claimKeyId: 'key-1', now: 1_800_000_000_000 }

function storedJson(record: ReturnType<typeof foundAgentSessionRecord>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(encodeAgentSessionRecord(record)))
}

describe('protected analysis marker on a stored agent-session record', () => {
  it('founds a protected record at schema 3 carrying exactly the marker', () => {
    const record = foundAgentSessionRecord({ ...IDENTITY, protectedAnalysis: MARKER }, LEASE)

    expect(record.schemaVersion).toBe(3)
    expect(record.protectedAnalysis).toEqual(MARKER)
  })

  it('keeps an ordinary record at schema 2 with no marker member', () => {
    const record = foundAgentSessionRecord(IDENTITY, LEASE)

    expect(record.schemaVersion).toBe(2)
    expect(Object.keys(storedJson(record))).not.toContain('protectedAnalysis')
  })

  it('round-trips a protected record through its stored row with the marker intact', () => {
    const record = foundAgentSessionRecord({ ...IDENTITY, protectedAnalysis: MARKER }, LEASE)
    const row = storedJson(record)

    expect(isPersistedAgentSessionRecord(row)).toBe(true)
    if (!isPersistedAgentSessionRecord(row)) {
      return
    }
    const decoded = decodePersistedAgentSessionRecord(row)
    expect(decoded.record.schemaVersion).toBe(3)
    expect(decoded.record.protectedAnalysis).toEqual(MARKER)
    expect(decoded.normalized).toBe(false)
  })

  describe('rejects a row that is not exactly a protected or an ordinary record', () => {
    const ordinaryRow = storedJson(foundAgentSessionRecord(IDENTITY, LEASE))
    const protectedRow = storedJson(
      foundAgentSessionRecord({ ...IDENTITY, protectedAnalysis: MARKER }, LEASE)
    )

    it('accepts a valid schema-3 row with a marker', () => {
      expect(
        isPersistedAgentSessionRecord({
          ...ordinaryRow,
          schemaVersion: 3,
          protectedAnalysis: MARKER
        })
      ).toBe(true)
    })

    it('rejects schema 3 without a marker', () => {
      expect(isPersistedAgentSessionRecord({ ...ordinaryRow, schemaVersion: 3 })).toBe(false)
    })

    it('rejects schema 2 with a marker, so an ordinary row cannot carry one', () => {
      expect(isPersistedAgentSessionRecord({ ...ordinaryRow, protectedAnalysis: MARKER })).toBe(
        false
      )
    })

    it.each([
      ['an owner that is not a UUID', { ...MARKER, ownerId: 'owner-1' }],
      ['a non-canonical item id', { ...MARKER, itemId: '007' }],
      ['a non-numeric item id', { ...MARKER, itemId: 'item-1' }],
      ['an uppercase owner UUID', { ...MARKER, ownerId: MARKER.ownerId.toUpperCase() }],
      ['an extra member', { ...MARKER, extra: true }],
      ['an empty instance id', { ...MARKER, instanceId: '' }],
      ['an unknown analysis kind', { ...MARKER, analysisKind: 'anything' }],
      ['a missing analysis kind', { ownerId: MARKER.ownerId, instanceId: 'i', itemId: '5' }],
      ['a non-object marker', 'protected']
    ])('rejects a schema-3 row whose marker has %s', (_name, marker) => {
      expect(isPersistedAgentSessionRecord({ ...protectedRow, protectedAnalysis: marker })).toBe(
        false
      )
    })
  })
})
