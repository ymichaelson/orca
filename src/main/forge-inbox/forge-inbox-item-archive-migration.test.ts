import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError, openForgeInboxDatabase } from './forge-inbox-database'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV16TablesSql } from './forge-inbox-schema-run-terminal'

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
}

describe('forge inbox v17 item archive migration', () => {
  let root: string
  let dbPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v17-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function createV16(extra = ''): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV16TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 4, 1, 1)`)
    raw.exec("INSERT INTO item_reads (client_id, item_id, read_seq) VALUES ('client-1', 1, 3)")
    raw.exec(extra)
    raw.pragma('user_version = 16')
    raw.close()
  }

  it('creates the archive table on a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(tableNames(opened.db)).toContain('item_archives')
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a v16 file keeping its items and read marks with no archive rows', () => {
    createV16()
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(opened.db.prepare('SELECT read_seq FROM item_reads').get()).toEqual({ read_seq: 3 })
      expect(opened.db.prepare('SELECT COUNT(*) AS n FROM item_archives').get()).toEqual({ n: 0 })
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('reopens the migrated file and keeps an archive row', () => {
    createV16()
    const first = openForgeInboxDatabase(dbPath, 'host-a')
    first.db.exec("INSERT INTO item_archives (client_id, item_id, archived_seq) VALUES ('c', 1, 4)")
    first.db.close()
    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(reopened.db.prepare('SELECT archived_seq FROM item_archives').get()).toEqual({
        archived_seq: 4
      })
    } finally {
      reopened.db.close()
    }
  })

  it('rolls the whole migration back when a later statement fails', () => {
    createV16('CREATE TABLE item_archives_by_item (x INTEGER)')

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow()

    const raw = new Database(dbPath)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(16)
      expect(tableNames(raw)).not.toContain('item_archives')
    } finally {
      raw.close()
    }
  })

  it('refuses a v17 file whose archive table is missing', () => {
    createV16()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()
    const raw = new Database(dbPath)
    raw.exec('DROP TABLE item_archives')
    raw.close()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxCorruptError)
  })
})
