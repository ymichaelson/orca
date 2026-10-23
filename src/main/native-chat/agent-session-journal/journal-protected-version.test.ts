import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalPragmaNumber, openJournalDatabase, runJournalTransaction } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  SAVED_BY_NEWER_ORCA
} from './journal-host-database-test-support'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'
import { commandReceiptScope } from './command-receipt-schema'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'

// The ordinary open still lands on 4; 5 is the lazily raised protected version and 6 is a newer build.
const ORDINARY = 4
const PROTECTED = 5
const NEWER = 6

describe('the journal database version ceiling', () => {
  let root: string
  let dbPath: string
  const journals = createTrackedJournalOpener()
  const scope = commandReceiptScope('caller-1', 'global')
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-protected-version-'))
    dbPath = journalDatabasePath(root)
  })

  afterEach(async () => {
    await journals.closeAll()
    closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  function stampVersion(version: number): void {
    const { db } = openJournalDatabase(dbPath)
    db.pragma(`user_version = ${version}`)
    db.close()
  }

  it('opens a fresh database at the ordinary version, writable', () => {
    const { db, readOnly } = openJournalDatabase(dbPath)
    try {
      expect(readOnly).toBe(false)
      expect(journalPragmaNumber(db, 'user_version')).toBe(ORDINARY)
    } finally {
      db.close()
    }
  })

  it('opens a database already at the protected version writable and never lowers it', () => {
    stampVersion(PROTECTED)

    const { db, readOnly } = openJournalDatabase(dbPath)
    try {
      expect(readOnly).toBe(false)
      expect(journalPragmaNumber(db, 'user_version')).toBe(PROTECTED)
    } finally {
      db.close()
    }
    const reopened = openJournalDatabase(dbPath)
    expect(journalPragmaNumber(reopened.db, 'user_version')).toBe(PROTECTED)
    reopened.db.close()
  })

  it('accepts a command receipt on a database at the protected version', () => {
    stampVersion(PROTECTED)
    const { db } = openJournalDatabase(dbPath)
    try {
      const receipt = commandReceiptFixture()
      const written = runJournalTransaction(db, () => {
        writeCommandReceiptTestRecord(db)
        return insertCommandReceiptIfAbsent(db, scope, receipt)
      })
      expect(written).toEqual({ inserted: true })
    } finally {
      db.close()
    }
  })

  it('opens a database past the protected version read-only and leaves the file untouched', async () => {
    stampVersion(NEWER)
    const before = await readFile(dbPath)

    const { db, readOnly } = openJournalDatabase(dbPath)
    try {
      expect(readOnly).toBe(true)
      expect(journalPragmaNumber(db, 'user_version')).toBe(NEWER)
      expect(() =>
        runJournalTransaction(db, () =>
          insertCommandReceiptIfAbsent(db, scope, commandReceiptFixture())
        )
      ).toThrow()
    } finally {
      db.close()
    }

    expect(await readFile(dbPath)).toEqual(before)
    expect((await stat(`${dbPath}-wal`).catch(() => null))?.size ?? 0).toBe(0)
  })

  it('refuses a chat replay in a database past the ceiling before disclosing any of it', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'secret analysis' }]
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journals.closeAll()
    stampVersion(NEWER)
    const before = await readFile(dbPath)

    await expect(journals.open({ identity: IDENTITY, stateDirectory: root })).rejects.toMatchObject(
      SAVED_BY_NEWER_ORCA
    )
    await journals.closeAll()
    expect(await readFile(dbPath)).toEqual(before)
  })
})
