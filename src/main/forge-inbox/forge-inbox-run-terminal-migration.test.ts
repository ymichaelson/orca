import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV15TablesSql } from './forge-inbox-schema-run-cancellation'

const TERMINAL_COLUMNS = [
  'terminal_handle',
  'terminal_pty_id',
  'terminal_incarnation_id',
  'terminal_execution_host_id',
  'terminal_worktree_id',
  'terminal_exit_kind',
  'terminal_exit_value',
  'terminal_exit_at',
  'dispatch_agent_id',
  'dispatch_requested_model',
  'dispatch_actual_model'
]

function runColumns(db: Database.Database): string[] {
  return db
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('runs')
    .map((row) => String(row.name))
}

describe('forge inbox v16 run terminal and dispatch snapshot migration', () => {
  let root: string
  let dbPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v16-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function createV15WithRun(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV15TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
      context_digest, analysis_kind, reason, error, created_at, updated_at)
      VALUES (1, 1, 1, 'unverifiable', 2, 1, 'sha256:head', 'merge_request',
        'project-event-dispatch', 'terminal-handoff', 5, 6)`)
    raw.pragma('user_version = 15')
    raw.close()
  }

  it('adds the columns to a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(runColumns(opened.db)).toEqual(expect.arrayContaining(TERMINAL_COLUMNS))
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a v15 file keeping its run with no terminal identity or snapshot', () => {
    createV15WithRun()
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      const row = opened.db
        .prepare(`SELECT state, error, ${TERMINAL_COLUMNS.join(', ')} FROM runs`)
        .get()
      expect(row).toMatchObject({ state: 'unverifiable', error: 'terminal-handoff' })
      for (const column of TERMINAL_COLUMNS) {
        expect(row?.[column]).toBeNull()
      }
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('reopens the migrated file', () => {
    createV15WithRun()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()
    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    reopened.db.close()
  })
})
