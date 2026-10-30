import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV11TablesSql } from './forge-inbox-schema-question-subject'

function runColumns(db: Database.Database): string[] {
  return db
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('runs')
    .map((row) => String(row.name))
}

describe('forge inbox v12 run dispatch turn migration', () => {
  let root: string
  let dbPath: string

  function createV11WithRun(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV11TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
      context_digest, analysis_kind, reason, error, session_id, created_at, updated_at)
      VALUES (1, 1, 1, 'unverifiable', 2, 1, 'sha256:head', 'merge_request',
        'project-event-dispatch', 'unknown-outcome', 'structured-claude-1', 5, 6)`)
    raw.pragma('user_version = 11')
    raw.close()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v12-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('adds the dispatch turn column to a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(runColumns(opened.db)).toContain('dispatch_client_message_id')
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a v11 file and keeps its run row without a dispatch turn', () => {
    createV11WithRun()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(runColumns(opened.db)).toContain('dispatch_client_message_id')
      expect(
        opened.db
          .prepare(
            `SELECT state, error, session_id, dispatch_client_message_id
             FROM runs WHERE id = 1`
          )
          .get()
      ).toEqual({
        state: 'unverifiable',
        error: 'unknown-outcome',
        session_id: 'structured-claude-1',
        dispatch_client_message_id: null
      })
    } finally {
      opened.db.close()
    }
  })

  it('reopens the migrated file at the current version', () => {
    createV11WithRun()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()

    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(runColumns(reopened.db)).toContain('dispatch_client_message_id')
      expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
    } finally {
      reopened.db.close()
    }
  })
})
