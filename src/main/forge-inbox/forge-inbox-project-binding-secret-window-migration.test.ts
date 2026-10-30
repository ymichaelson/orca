import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { createForgeInboxV9TablesSql } from './forge-inbox-project-event-question-schema'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'

const SECRET_BYTES = Buffer.from('{"bindingId":"binding","secret":"live-secret"}', 'utf8')

describe('forge inbox v10 binding secret window migration', () => {
  let root: string
  let dbPath: string

  function createV9WithSecret(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV9TablesSql())
    raw.prepare("INSERT INTO meta VALUES ('host_id', 'host-a')").run()
    raw
      .prepare(
        `INSERT INTO project_bindings (binding_id, project_path, gitlab_host, gitlab_path,
           gitlab_project_id, callback_url, state, secret_protection, secret_envelope,
           created_at, updated_at)
         VALUES ('binding', '/repo', 'gitlab.test', 'group/demo', 3, 'https://x/y', 'connected',
           'plaintext', ?, 1, 1)`
      )
      .run(SECRET_BYTES)
    raw.pragma('user_version = 9')
    raw.close()
  }

  const bindingRow = (db: Database.Database) =>
    db
      .prepare(
        `SELECT secret_protection, hex(secret_envelope) AS secret_hex,
           previous_secret_envelope, previous_secret_expires_at
         FROM project_bindings WHERE binding_id = 'binding'`
      )
      .get()

  const version = (db: Database.Database) => Number(db.pragma('user_version', { simple: true }))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v10-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('adds the previous-secret window to a v9 file without touching the live secret', () => {
    createV9WithSecret()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(version(opened.db)).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(bindingRow(opened.db)).toEqual({
        secret_protection: 'plaintext',
        secret_hex: SECRET_BYTES.toString('hex').toUpperCase(),
        previous_secret_envelope: null,
        previous_secret_expires_at: null
      })
    } finally {
      opened.db.close()
    }
  })

  it('reopens a migrated file without rerunning the window migration', () => {
    createV9WithSecret()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()

    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(version(reopened.db)).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(bindingRow(reopened.db)).toEqual({
        secret_protection: 'plaintext',
        secret_hex: SECRET_BYTES.toString('hex').toUpperCase(),
        previous_secret_envelope: null,
        previous_secret_expires_at: null
      })
    } finally {
      reopened.db.close()
    }
  })

  it('creates the window columns on a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      const columns = opened.db
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all('project_bindings')
        .map((row) => row.name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'previous_secret_protection',
          'previous_secret_gap',
          'previous_secret_envelope',
          'previous_secret_expires_at'
        ])
      )
    } finally {
      opened.db.close()
    }
  })
})
