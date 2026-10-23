import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { journalPragmaNumber } from '../native-chat/agent-session-journal/journal-database'
import type { AgentSessionFoundingRequest } from './agent-session-founding-admission'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'

let root: string
let operation = 0
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-protected-launch-record-'))
})
afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function request() {
  operation += 1
  const launch = protectedClaudeLaunchFixture(
    join(root, 'forge-protected-analysis', 'session-alpha')
  )
  return {
    sessionId: 'session-alpha',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    options: { model: 'opus' },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(launch.privateRoot, 'config') },
    launchDirectory: '/fake/original-folder',
    protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
    protectedClaudeLaunch: launch,
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'not started' },
    operation: {
      callerKey: 'host',
      operationId: `1800000000000-${String(operation).padStart(32, '0')}`,
      fingerprint: 'fp-1'
    },
    now: 1_800_000_000_000
  } as const
}
function version() {
  return journalPragmaNumber(openTestJournalHostDatabase(root).db, 'user_version')
}

describe('protected Claude metadata uses the existing founding transaction and immutable record writer', () => {
  it.each(['commit', 'receipt'] as const)(
    'round-trips host launch metadata through founding.%s and its lazy version-5 fence',
    async (path) => {
      const store = await openTestAgentSessionRecordStore(root)
      const req = request()
      expect(version()).toBe(4)
      store.founding.prepare(req)
      expect(version()).toBe(4)
      if (path === 'commit') {
        await store.founding.commit(req)
      } else {
        const receipt = store.founding.receipt(req)
        expect(version()).toBe(4)
        openTestJournalHostDatabase(root).transaction((db) => receipt.write(db))
        receipt.committed()
      }
      expect(version()).toBe(5)
      expect(store.getRecord(req.sessionId)).toMatchObject({
        protectedClaudeLaunch: req.protectedClaudeLaunch,
        accountHome: req.accountHome,
        launchDirectory: req.launchDirectory,
        location: req.location
      })
      expect((await readPersistedTestAgentSessionStore(root)).records[req.sessionId]).toMatchObject(
        {
          protectedClaudeLaunch: req.protectedClaudeLaunch
        }
      )
    }
  )

  it.each(['prepare', 'commit', 'receipt'] as const)(
    'rejects malformed metadata on %s without any row or DB fence bump',
    async (path) => {
      const store = await openTestAgentSessionRecordStore(root)
      const req = request()
      const invalid: AgentSessionFoundingRequest = {
        ...req,
        // @ts-expect-error -- a wire-shaped version no build understands must be refused at the store.
        protectedClaudeLaunch: { ...req.protectedClaudeLaunch, version: 999 }
      }
      const attempt = async () => {
        if (path === 'prepare') {
          store.founding.prepare(invalid)
        } else if (path === 'commit') {
          await store.founding.commit(invalid)
        } else {
          const receipt = store.founding.receipt(invalid)
          openTestJournalHostDatabase(root).transaction((db) => receipt.write(db))
        }
      }
      await expect(attempt()).rejects.toThrow('agent_session_store_write_invalid')
      expect(version()).toBe(4)
      expect(store.getRecord(req.sessionId)).toBeNull()
      expect((await readPersistedTestAgentSessionStore(root)).records).toEqual({})
    }
  )

  it('strips both protected fields from ordinary reserve NEW without raising version 5', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const reserved = await store.reserveOwner(request())
    expect(reserved.record.schemaVersion).toBe(2)
    expect(reserved.record).not.toHaveProperty('protectedAnalysis')
    expect(reserved.record).not.toHaveProperty('protectedClaudeLaunch')
    expect(version()).toBe(4)
  })

  it.each(['model-change', 'model-remove'] as const)(
    'rejects %s through the existing record writer',
    async (change) => {
      const store = await openTestAgentSessionRecordStore(root)
      const req = request()
      await store.founding.commit(req)
      await expect(
        store.transitionHandoff(req.sessionId, (record) => ({
          ...record,
          options: change === 'model-change' ? { model: 'another-model' } : undefined
        }))
      ).rejects.toThrow('agent_session_store_write_invalid')
    }
  )

  it('permits an idempotent pinned model write', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const req = request()
    await store.founding.commit(req)
    await store.transitionHandoff(req.sessionId, (record) => ({
      ...record,
      options: { model: 'opus' }
    }))
    expect(store.getRecord(req.sessionId)?.options?.model).toBe('opus')
  })

  it.each(['auth', 'privateRoot', 'executable', 'accountHome', 'remove'] as const)(
    'refuses immutable %s changes at the common record write choke point',
    async (change) => {
      const store = await openTestAgentSessionRecordStore(root)
      const req = request()
      await store.founding.commit(req)
      expect(store.getRecord(req.sessionId)).toHaveProperty(
        'protectedClaudeLaunch',
        req.protectedClaudeLaunch
      )
      const before = await readPersistedTestAgentSessionStore(root)
      const transition = (record: AgentSessionRecord) => {
        const complete = { ...record, protectedClaudeLaunch: req.protectedClaudeLaunch }
        if (change === 'remove') {
          const { protectedClaudeLaunch: _launch, ...rest } = complete
          return rest
        }
        if (change === 'accountHome') {
          return {
            ...complete,
            accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/fake/ordinary-home' }
          }
        }
        const launch = req.protectedClaudeLaunch
        return {
          ...complete,
          protectedClaudeLaunch:
            change === 'auth'
              ? { ...launch, auth: { ...launch.auth, baseUrl: 'https://other.example.test' } }
              : change === 'privateRoot'
                ? { ...launch, privateRoot: '/fake/other-private-root' }
                : { ...launch, executable: { ...launch.executable, path: '/fake/other-native' } }
        }
      }
      await expect(store.transitionHandoff(req.sessionId, transition)).rejects.toThrow(
        'agent_session_store_write_invalid'
      )
      expect(await readPersistedTestAgentSessionStore(root)).toEqual(before)
    }
  )

  it('retains the pinned launch, original location, and private account home when reserving a resume', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const req = request()
    await store.founding.commit(req)
    const founded = store.getRecord(req.sessionId)
    if (!founded) {
      throw new Error('Missing founded record')
    }
    const reserved = await store.reserveOwner({
      ...request(),
      expectedFence: founded.lease.runtimeFence
    })
    expect(reserved.record).toMatchObject({
      protectedClaudeLaunch: req.protectedClaudeLaunch,
      protectedAnalysis: req.protectedAnalysis,
      location: req.location,
      accountHome: req.accountHome,
      launchDirectory: req.launchDirectory
    })
  })
})
