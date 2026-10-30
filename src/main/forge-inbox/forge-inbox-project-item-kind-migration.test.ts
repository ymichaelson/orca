import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxSchemaError, openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV12TablesSql } from './forge-inbox-schema-run-dispatch-turn'

const INSERT_PROJECT_ITEM = `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title,
  state, current_revision, head_order, activity_seq, created_at, updated_at)
  VALUES ('host-a', 'gitlab:gitlab.test', 'group/demo', 'project', 0, 'group/demo', 'unknown',
    1, 1, 0, 1, 1)`

describe('forge inbox v13 project item kind migration', () => {
  let root: string
  let dbPath: string

  function createV12WithLinkedRows(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV12TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at) VALUES
      (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 3, 1, 1),
      (2, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'pipeline', 7, 'Pipeline #7',
        'failed', 1, 1, 4, 2, 2)`)
    raw.exec(`INSERT INTO item_revisions (id, item_id, revision, version_token, source_order,
      created_at) VALUES (1, 1, 1, 'sha256:head', 1, 1), (2, 2, 1, 'sha256:pipe', 1, 2)`)
    raw.exec(`INSERT INTO events (id, item_id, revision, event_kind, version_token, source_order,
      payload_json, received_at) VALUES (1, 1, 1, 'Merge Request Hook', 'sha256:head', 1, '{}', 1)`)
    raw.exec(`INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
      context_digest, analysis_kind, reason, created_at, updated_at)
      VALUES (1, 1, 1, 'succeeded', 2, 1, 'sha256:head', 'merge_request', 'review', 5, 6)`)
    raw.exec(`INSERT INTO proposals (id, run_id, item_id, revision, policy_generation, status,
      body_json, created_at) VALUES (1, 1, 1, 1, 1, 'pending', '{}', 7)`)
    raw.exec("INSERT INTO item_reads (client_id, item_id, read_seq) VALUES ('client-a', 1, 3)")
    raw.pragma('user_version = 12')
    raw.close()
  }

  function storedShape(): { version: unknown; schema: string; items: unknown[] } {
    const raw = new Database(dbPath)
    try {
      return {
        version: raw.pragma('user_version', { simple: true }),
        schema: raw
          .prepare('SELECT name, sql FROM sqlite_master ORDER BY name')
          .all()
          .map((row) => `${String(row.name)} ${String(row.sql)}`)
          .join('\n'),
        items: raw.prepare('SELECT * FROM items ORDER BY id').all()
      }
    } finally {
      raw.close()
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v13-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('upgrades a v12 file keeping every item and the rows that point at it', () => {
    createV12WithLinkedRows()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(
        opened.db.prepare('SELECT id, kind, iid, title, activity_seq FROM items ORDER BY id').all()
      ).toEqual([
        { id: 1, kind: 'merge_request', iid: 7, title: 'Add thing', activity_seq: 3 },
        { id: 2, kind: 'pipeline', iid: 7, title: 'Pipeline #7', activity_seq: 4 }
      ])
      for (const table of ['item_revisions', 'events', 'runs', 'proposals', 'item_reads']) {
        expect(opened.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).not.toEqual({
          count: 0
        })
      }
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
      expect(opened.db.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      opened.db.close()
    }
  })

  it('accepts a project item and still refuses an unknown kind after the upgrade', () => {
    createV12WithLinkedRows()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      opened.db.exec(INSERT_PROJECT_ITEM)
      expect(() =>
        opened.db.exec(INSERT_PROJECT_ITEM.replace("'project', 0", "'snippet', 0"))
      ).toThrow(/CHECK constraint/)
      expect(() =>
        opened.db.exec(`INSERT INTO runs (item_id, revision, state, policy_generation,
          context_digest, analysis_kind, reason, created_at, updated_at)
          VALUES (999, 1, 'queued', 1, 'x', 'project', 'x', 1, 1)`)
      ).toThrow(/FOREIGN KEY/)
    } finally {
      opened.db.close()
    }
  })

  it('keeps the other tables pointing at items and the activity index in place', () => {
    createV12WithLinkedRows()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      const sql = opened.db
        .prepare('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL')
        .all()
        .map((row) => `${String(row.name)} ${String(row.sql)}`)
        .join('\n')
      expect(sql).not.toMatch(/items_v13|items_v12/)
      expect(
        opened.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items'")
          .all()
          .map((row) => String(row.name))
      ).toContain('items_by_activity')
    } finally {
      opened.db.close()
    }
  })

  it('refuses a v12 file that already violates a foreign key and leaves it at v12', () => {
    createV12WithLinkedRows()
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`INSERT INTO events (item_id, revision, event_kind, version_token, source_order,
      payload_json, received_at) VALUES (404, 1, 'Merge Request Hook', 'x', 1, '{}', 1)`)
    raw.close()

    const before = storedShape()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(/foreign key/i)

    expect(storedShape()).toEqual(before)
    expect(before.version).toBe(12)
    expect(before.schema).not.toMatch(/items_v13/)
  })

  it('leaves a file written by a newer build byte-identical and refuses it', () => {
    createV12WithLinkedRows()
    const raw = new Database(dbPath)
    raw.pragma(`user_version = ${FORGE_INBOX_SCHEMA_VERSION + 1}`)
    raw.close()
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex')

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxSchemaError)

    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(before)
  })

  it('reopens the migrated file at the current version', () => {
    createV12WithLinkedRows()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()

    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 2 })
    } finally {
      reopened.db.close()
    }
  })
})
