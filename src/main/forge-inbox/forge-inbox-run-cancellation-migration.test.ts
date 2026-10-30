import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV14TablesSql } from './forge-inbox-schema-dispatch-confirmation'

const CANCEL_COLUMNS = [
  'cancel_requested_at',
  'cancel_operation_id',
  'cancel_policy_generation',
  'cancel_delivery',
  'cancel_fence'
]

function runColumns(db: Database.Database): string[] {
  return db
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('runs')
    .map((row) => String(row.name))
}

describe('forge inbox v15 run cancellation migration', () => {
  let root: string
  let dbPath: string

  function createV14WithRun(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV14TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
      context_digest, analysis_kind, reason, error, session_id, dispatch_client_message_id,
      created_at, updated_at)
      VALUES (1, 1, 1, 'unverifiable', 2, 1, 'sha256:head', 'merge_request',
        'project-event-dispatch', 'unknown-outcome', 'structured-claude-1', 'message-1', 5, 6)`)
    raw.pragma('user_version = 14')
    raw.close()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v15-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('adds the cancellation columns to a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(runColumns(opened.db)).toEqual(expect.arrayContaining(CANCEL_COLUMNS))
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a v14 file and keeps its run without a stop request', () => {
    createV14WithRun()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(
        opened.db
          .prepare(
            `SELECT state, error, session_id, dispatch_client_message_id, cancel_requested_at,
               cancel_operation_id, cancel_policy_generation, cancel_delivery, cancel_fence
             FROM runs WHERE id = 1`
          )
          .get()
      ).toEqual({
        state: 'unverifiable',
        error: 'unknown-outcome',
        session_id: 'structured-claude-1',
        dispatch_client_message_id: 'message-1',
        cancel_requested_at: null,
        cancel_operation_id: null,
        cancel_policy_generation: null,
        cancel_delivery: null,
        cancel_fence: null
      })
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('reopens the migrated file and refuses a file from a newer build', () => {
    createV14WithRun()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()
    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    reopened.db.close()

    const raw = new Database(dbPath)
    raw.pragma(`user_version = ${FORGE_INBOX_SCHEMA_VERSION + 1}`)
    raw.close()
    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(/newer than this build/)
  })
})
