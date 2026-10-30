import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxSchemaError, openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV13TablesSql } from './forge-inbox-schema-project-item-kind'

const TABLE = 'run_dispatch_confirmations'

const INSERT_CONFIRMATION = `INSERT INTO ${TABLE} (run_id, host_id, state, binding_id, gitlab_host,
  gitlab_project_id, item_kind, item_iid, marker, created_at, updated_at)
  VALUES (1, 'host-a', 'unconfirmed', 'binding-a', 'gitlab.test', 3, 'merge_request', 7,
    '<!-- orca-run:1:abc -->', 1, 1)`

describe('forge inbox v14 dispatch confirmation migration', () => {
  let root: string
  let dbPath: string

  function createV13WithRun(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV13TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
      context_digest, analysis_kind, reason, session_id, created_at, updated_at)
      VALUES (1, 1, 1, 'succeeded', 2, 1, 'sha256:head', 'merge_request',
        'project-event-dispatch', 'structured-claude-1', 5, 6)`)
    raw.pragma('user_version = 13')
    raw.close()
  }

  function storedShape(): { version: unknown; schema: string; runs: unknown[] } {
    const raw = new Database(dbPath)
    try {
      return {
        version: raw.pragma('user_version', { simple: true }),
        schema: raw
          .prepare('SELECT name, sql FROM sqlite_master ORDER BY name')
          .all()
          .map((row) => `${String(row.name)} ${String(row.sql)}`)
          .join('\n'),
        runs: raw.prepare('SELECT * FROM runs ORDER BY id').all()
      }
    } finally {
      raw.close()
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v14-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the confirmation table in a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(opened.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get()).toEqual({
        count: 0
      })
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a v13 file keeping its rows, with no confirmation for the old run', () => {
    createV13WithRun()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(opened.db.prepare('SELECT id, state, session_id FROM runs').all()).toEqual([
        { id: 1, state: 'succeeded', session_id: 'structured-claude-1' }
      ])
      expect(opened.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get()).toEqual({
        count: 0
      })
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('accepts a confirmation for a run and refuses an unknown state, an oversize report or a missing run', () => {
    createV13WithRun()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      opened.db.exec(INSERT_CONFIRMATION)
      expect(() =>
        opened.db.exec(
          INSERT_CONFIRMATION.replace("'unconfirmed'", "'verified'").replace('(1,', '(2,')
        )
      ).toThrow(/CHECK constraint/)
      expect(() =>
        opened.db
          .prepare(`UPDATE ${TABLE} SET report_json = ? WHERE run_id = 1`)
          .run('x'.repeat(8193))
      ).toThrow(/CHECK constraint/)
      expect(() => opened.db.exec(INSERT_CONFIRMATION.replace('(1,', '(999,'))).toThrow(
        /FOREIGN KEY/
      )
    } finally {
      opened.db.close()
    }
  })

  it('refuses a v13 file that already violates a foreign key and leaves it at v13', () => {
    createV13WithRun()
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`INSERT INTO events (item_id, revision, event_kind, version_token, source_order,
      payload_json, received_at) VALUES (404, 1, 'Merge Request Hook', 'x', 1, '{}', 1)`)
    raw.close()

    const before = storedShape()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(/foreign key/i)

    expect(storedShape()).toEqual(before)
    expect(before.version).toBe(13)
    expect(before.schema).not.toContain(TABLE)
  })

  it('leaves a file written by a newer build byte-identical and refuses it', () => {
    createV13WithRun()
    const raw = new Database(dbPath)
    raw.pragma(`user_version = ${FORGE_INBOX_SCHEMA_VERSION + 1}`)
    raw.close()
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex')

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxSchemaError)

    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(before)
  })

  it('reopens the migrated file at the current version keeping a confirmation row', () => {
    createV13WithRun()
    const first = openForgeInboxDatabase(dbPath, 'host-a')
    expect(first.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
    first.db.exec(INSERT_CONFIRMATION)
    first.db.close()

    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(reopened.db.prepare(`SELECT run_id, state FROM ${TABLE}`).all()).toEqual([
        { run_id: 1, state: 'unconfirmed' }
      ])
    } finally {
      reopened.db.close()
    }
  })
})
