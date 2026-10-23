import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { journalPragmaNumber } from '../native-chat/agent-session-journal/journal-database'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionFoundingRequest } from './agent-session-founding-admission'

// The ordinary open lands on 4; the first protected record write raises it to 5; 6 is a newer build.
const ORDINARY = 4
const PROTECTED = 5
const NEWER = 6

const NOW = 1_800_000_000_000
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const MARKER = {
  ownerId: '0b8f2c1e-5a3d-4f6b-9c7e-1d2a3b4c5d6e',
  instanceId: 'instance-1',
  itemId: '101',
  analysisKind: 'merge_request'
} as const
const OTHER_MARKER = { ...MARKER, itemId: '102' } as const

let counter = 0

function request(
  overrides: Partial<AgentSessionFoundingRequest> = {}
): AgentSessionFoundingRequest {
  counter += 1
  return {
    sessionId: 'session-alpha',
    location: LOCATION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no answer' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${String(counter).padStart(32, '0')}`,
      fingerprint: 'fp-1'
    },
    now: NOW,
    ...overrides
  }
}

describe('the protected analysis marker and the journal version fence', () => {
  let root: string
  let store: AgentSessionRecordStore | null = null

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-protected-record-'))
  })

  afterEach(async () => {
    closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  async function open(): Promise<AgentSessionRecordStore> {
    store = await openTestAgentSessionRecordStore(root)
    return store
  }

  async function reopen(): Promise<AgentSessionRecordStore> {
    closeTestJournalHostDatabase(root)
    return open()
  }

  function version(): number {
    return journalPragmaNumber(openTestJournalHostDatabase(root).db, 'user_version')
  }

  function stamp(user_version: number): void {
    openTestJournalHostDatabase(root).db.pragma(`user_version = ${user_version}`)
    closeTestJournalHostDatabase(root)
  }

  /** The two write paths a founding takes: its own store transaction, and the receipt a first
   *  message commits alongside its journal row. */
  const paths = {
    'the standalone store transaction': async (
      target: AgentSessionRecordStore,
      req: AgentSessionFoundingRequest
    ) => {
      await target.founding.commit(req)
    },
    'the first-message receipt co-write': async (
      target: AgentSessionRecordStore,
      req: AgentSessionFoundingRequest
    ) => {
      const receipt = target.founding.receipt(req)
      openTestJournalHostDatabase(root).transaction((db) => receipt.write(db))
      receipt.committed()
    }
  }

  describe.each(Object.entries(paths))('through %s', (_name, found) => {
    it('keeps the version at 4 for an ordinary record, stored at schema 2', async () => {
      await found(await open(), request())

      expect(version()).toBe(ORDINARY)
      const stored = (await readPersistedTestAgentSessionStore(root)).records['session-alpha']
      expect(stored?.schemaVersion).toBe(2)
      expect(Object.keys(stored ?? {})).not.toContain('protectedAnalysis')
    })

    it('raises the version to 5 with the first protected record, stored at schema 3', async () => {
      const target = await open()

      await found(target, request({ protectedAnalysis: MARKER }))

      expect(version()).toBe(PROTECTED)
      expect(target.getRecord('session-alpha')?.protectedAnalysis).toEqual(MARKER)
      const stored = (await readPersistedTestAgentSessionStore(root)).records['session-alpha']
      expect(stored?.schemaVersion).toBe(3)
      expect(stored?.protectedAnalysis).toEqual(MARKER)

      const reopened = await reopen()
      expect(version()).toBe(PROTECTED)
      expect(reopened.getRecord('session-alpha')?.protectedAnalysis).toEqual(MARKER)
    })

    it('leaves a failed or refused founding at version 4', async () => {
      const target = await open()
      await found(target, request())

      await expect(found(target, request({ protectedAnalysis: MARKER }))).rejects.toMatchObject({
        refusal: { code: 'agent_session_conflict' }
      })

      expect(version()).toBe(ORDINARY)
      expect(target.getRecord('session-alpha')?.protectedAnalysis).toBeUndefined()
    })

    it('rolls rows, memory and version back together when a later row write fails', async () => {
      const target = await open()
      const { db } = openTestJournalHostDatabase(root)
      db.exec(`CREATE TEMP TRIGGER fail_operation_row AFTER INSERT ON main.agent_session_operations
BEGIN SELECT RAISE(ABORT, 'injected row failure'); END`)
      const protectedRequest = request({ protectedAnalysis: MARKER })

      await expect(found(target, protectedRequest)).rejects.toThrow('injected row failure')

      expect(version()).toBe(ORDINARY)
      expect(target.getRecord('session-alpha') !== null).toBe(false)
      expect((await readPersistedTestAgentSessionStore(root)).records).toEqual({})
      const reopened = await reopen()
      expect(version()).toBe(ORDINARY)
      expect(reopened.listRecords().length).toBe(0)

      await found(reopened, protectedRequest)
      expect(version()).toBe(PROTECTED)
    })

    it('rolls rows, memory and version back together when COMMIT itself fails', async () => {
      const target = await open()
      const { db } = openTestJournalHostDatabase(root)
      db.exec(`CREATE TEMP TABLE commit_probe_parent (id INTEGER PRIMARY KEY);
CREATE TEMP TABLE commit_probe_child (
  parent INTEGER REFERENCES commit_probe_parent (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TEMP TRIGGER commit_probe AFTER INSERT ON main.agent_session_records
BEGIN INSERT INTO commit_probe_child (parent) VALUES (1); END`)
      const protectedRequest = request({ protectedAnalysis: MARKER })

      await expect(found(target, protectedRequest)).rejects.toThrow('FOREIGN KEY constraint failed')

      expect(db.isTransaction).toBe(false)
      expect(version()).toBe(ORDINARY)
      expect(target.getRecord('session-alpha') !== null).toBe(false)
      const reopened = await reopen()
      expect(version()).toBe(ORDINARY)
      expect((await readPersistedTestAgentSessionStore(root)).records).toEqual({})

      await found(reopened, protectedRequest)
      expect(version()).toBe(PROTECTED)
    })

    it('keeps a version that is already 5 when an ordinary record is written', async () => {
      await open()
      stamp(PROTECTED)
      const target = await open()

      await found(target, request())

      expect(version()).toBe(PROTECTED)
      await reopen()
      expect(version()).toBe(PROTECTED)
    })
  })

  it('does not raise the version when the store only starts, reads or lists', async () => {
    const target = await open()
    target.listByScope(LOCATION)
    await reopen()

    expect(version()).toBe(ORDINARY)
  })

  it('refuses to write past the ceiling and leaves the file byte-identical', async () => {
    await open()
    stamp(NEWER)
    const path = journalDatabasePath(root)
    const before = await readFile(path)
    const target = await open()

    expect(target.readOnly).toBe(true)
    await expect(
      target.founding.commit(request({ protectedAnalysis: MARKER }))
    ).rejects.toMatchObject({
      refusal: { code: 'agent_session_journal_unreadable' }
    })
    closeTestJournalHostDatabase(root)

    expect(await readFile(path)).toEqual(before)
    expect((await stat(`${path}-wal`).catch(() => null))?.size ?? 0).toBe(0)
  })

  describe('marker immutability', () => {
    const INVALID = 'agent_session_store_write_invalid'

    it.each([
      [
        'changes the marker',
        (record: AgentSessionRecord) => ({ ...record, protectedAnalysis: OTHER_MARKER })
      ],
      [
        'removes the marker',
        ({ protectedAnalysis: _marker, ...rest }: AgentSessionRecord) => ({
          ...rest,
          schemaVersion: 2 as const
        })
      ]
    ])('refuses a transition that %s of a protected record', async (_name, transition) => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const before = target.getRecord('session-alpha')
      const stored = await readPersistedTestAgentSessionStore(root)

      await expect(target.transitionHandoff('session-alpha', transition)).rejects.toThrow(INVALID)

      expect(target.getRecord('session-alpha')).toEqual(before)
      expect(await readPersistedTestAgentSessionStore(root)).toEqual(stored)
    })

    it('refuses a transition that adds a marker to an ordinary record', async () => {
      const target = await open()
      await target.founding.commit(request())
      const before = target.getRecord('session-alpha')

      await expect(
        target.transitionHandoff('session-alpha', (record) => ({
          ...record,
          schemaVersion: 3,
          protectedAnalysis: MARKER
        }))
      ).rejects.toThrow(INVALID)

      expect(target.getRecord('session-alpha')).toEqual(before)
      expect(version()).toBe(ORDINARY)
    })

    it.each<[string, Partial<AgentSessionFoundingRequest>]>([
      ['a protected', { protectedAnalysis: MARKER }],
      ['an ordinary', {}]
    ])('still lets %s record take ordinary updates', async (_name, extra) => {
      const target = await open()
      await target.founding.commit(request(extra))

      await target.setConversationName('session-alpha', 'renamed')
      const touched = await target.transitionHandoff('session-alpha', (record) => ({
        ...record,
        updatedAt: record.updatedAt + 1
      }))

      expect(touched.protectedAnalysis).toEqual(extra.protectedAnalysis)
      expect(target.getRecord('session-alpha')?.conversationName).toBe('renamed')
    })

    it.each(['prepare', 'commit', 'receipt'] as const)(
      'refuses an invalid marker on founding.%s before writing',
      async (path) => {
        const target = await open()
        const invalid = request({ protectedAnalysis: { ...MARKER, itemId: 'item-1' } })

        const attempt = () => {
          if (path === 'commit') {
            return target.founding.commit(invalid)
          }
          if (path === 'prepare') {
            return Promise.resolve().then(() => target.founding.prepare(invalid))
          }
          const receipt = target.founding.receipt(invalid)
          return Promise.resolve().then(() =>
            openTestJournalHostDatabase(root).transaction((db) => receipt.write(db))
          )
        }

        await expect(attempt()).rejects.toThrow(INVALID)
        expect(target.getRecord('session-alpha')).toBeNull()
        expect(version()).toBe(ORDINARY)
      }
    )
  })

  describe('a reservation, resume or adoption', () => {
    it('keeps the marker and the identity of a protected record it resumes', async () => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const founded = target.getRecord('session-alpha') ?? undefined
      expect(founded?.protectedAnalysis).toEqual(MARKER)

      const reserved = await target.reserveOwner(
        request({
          expectedFence: founded?.lease.runtimeFence ?? null,
          protectedAnalysis: OTHER_MARKER
        })
      )

      expect(reserved.record.protectedAnalysis).toEqual(MARKER)
      expect(reserved.record.schemaVersion).toBe(3)
      expect(reserved.record.location).toEqual(LOCATION)
      expect(
        (await readPersistedTestAgentSessionStore(root)).records['session-alpha']?.protectedAnalysis
      ).toEqual(MARKER)
      expect(version()).toBe(PROTECTED)
    })

    it('creates an ordinary record when a reservation supplies a marker', async () => {
      const target = await open()

      const created = await target.reserveOwner(request({ protectedAnalysis: MARKER }))

      expect(created.record.protectedAnalysis).toBeUndefined()
      expect(created.record.schemaVersion).toBe(2)
      expect(version()).toBe(ORDINARY)
    })

    it('keeps the marker when a request without one resumes a protected record', async () => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const founded = target.getRecord('session-alpha') ?? undefined

      const reserved = await target.reserveOwner(
        request({ expectedFence: founded?.lease.runtimeFence ?? null })
      )

      expect(reserved.record.protectedAnalysis).toEqual(MARKER)
    })

    it('never adds a marker to an ordinary record', async () => {
      const target = await open()
      await target.founding.commit(request())
      const founded = target.getRecord('session-alpha') ?? undefined

      const reserved = await target.reserveOwner(
        request({
          expectedFence: founded?.lease.runtimeFence ?? null,
          protectedAnalysis: MARKER
        })
      )

      expect(reserved.record.protectedAnalysis).toBeUndefined()
      expect(reserved.record.schemaVersion).toBe(2)
      expect(version()).toBe(ORDINARY)
    })

    it('refuses a create over a protected record that never started, rather than replacing it', async () => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const before = target.getRecord('session-alpha') ?? undefined

      await expect(target.reserveOwner(request({ expectedFence: null }))).rejects.toMatchObject({
        refusal: { code: 'agent_session_conflict' }
      })

      expect(target.getRecord('session-alpha') ?? undefined).toEqual(before)
    })

    it('refuses an adoption into a protected record and leaves it as it was', async () => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const before = target.getRecord('session-alpha') ?? undefined

      await expect(
        target.reserveOwner(
          request({
            adoptedHandleLink: {
              linkId: 'link-1',
              handle: codexProviderHandle('thread-1'),
              origin: 'adopted',
              mintedAtFence: 1,
              observedAt: NOW
            }
          })
        )
      ).rejects.toMatchObject({ refusal: { code: 'agent_session_conflict' } })

      expect(target.getRecord('session-alpha') ?? undefined).toEqual(before)
    })

    it('refuses a workspace change on a protected record', async () => {
      const target = await open()
      await target.founding.commit(request({ protectedAnalysis: MARKER }))
      const before = target.getRecord('session-alpha') ?? undefined

      await expect(
        target.reserveOwner(
          request({
            expectedFence: before?.lease.runtimeFence ?? null,
            location: { ...LOCATION, workspaceId: 'workspace-2' }
          })
        )
      ).rejects.toMatchObject({ refusal: { details: { reason: 'identityMismatch' } } })

      expect(target.getRecord('session-alpha') ?? undefined).toEqual(before)
    })
  })
})
