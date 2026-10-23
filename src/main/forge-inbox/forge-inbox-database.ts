// `PRAGMA user_version` is read FIRST on a connection that has set no persistent pragma: a
// database from a newer build or a corrupt file must stay byte-identical, and WAL writes the header.

import { randomUUID } from 'node:crypto'
import Database from '../sqlite/sync-database'
import { forgeCommitSignal } from './forge-inbox-commit-signal'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import {
  createForgeInboxPatchRequestsTableSql,
  createForgeInboxTablesSql,
  FORGE_INBOX_SCHEMA_VERSION,
  FORGE_INBOX_TABLES,
  FORGE_INBOX_V1_TABLES,
  FORGE_INBOX_V1_TABLES_SQL
} from './forge-inbox-schema'

export const FORGE_INBOX_BUSY_TIMEOUT_MS = 5000

export class ForgeInboxSchemaError extends Error {}
export class ForgeInboxHostMismatchError extends Error {}
export class ForgeInboxCorruptError extends Error {}

/**
 * The file belongs to one owner host, persisted on first open and checked on every later one.
 * Without an explicit hostId a new file mints a random one; an existing file must already hold its own.
 */
export function openForgeInboxDatabase(
  dbPath: string,
  requestedHostId?: string
): { db: Database.Database; hostId: string } {
  const db = new Database(dbPath)
  try {
    const stored = Number(db.pragma('user_version', { simple: true }) ?? 0)
    if (stored < 0) {
      throw new ForgeInboxSchemaError(`forge inbox ${dbPath} has invalid schema version ${stored}`)
    }
    if (stored > FORGE_INBOX_SCHEMA_VERSION) {
      throw new ForgeInboxSchemaError(
        `forge inbox ${dbPath} uses schema ${stored}, newer than this build supports (${FORGE_INBOX_SCHEMA_VERSION})`
      )
    }
    if (stored === 0 && hasSchemaObjects(db)) {
      throw new ForgeInboxSchemaError(`forge inbox ${dbPath} is an existing unversioned database`)
    }
    if (stored > 0) {
      assertForgeInboxIntact(db, dbPath, stored)
      // Refuse a foreign owner before WAL or the additive migration can change the file.
      if (requestedHostId !== undefined) {
        const owner = db.prepare("SELECT value FROM meta WHERE key = 'host_id'").get()
        if (owner?.value !== requestedHostId) {
          throw new ForgeInboxHostMismatchError(`forge inbox ${dbPath} belongs to another host`)
        }
      }
    }
    db.pragma('journal_mode = WAL')
    db.pragma(`busy_timeout = ${FORGE_INBOX_BUSY_TIMEOUT_MS}`)
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = FULL')
    db.pragma('checkpoint_fullfsync = ON')
    if (stored < FORGE_INBOX_SCHEMA_VERSION) {
      // Tables and the version bump commit together so a shaped file never reports version 0.
      runForgeTransaction(db, () => {
        if (stored === 0) {
          db.exec(createForgeInboxTablesSql())
          db.prepare("INSERT INTO meta (key, value) VALUES ('host_id', ?)").run(
            requestedHostId ?? randomUUID()
          )
        } else {
          // v1 to v2 is additive: existing rows and credential bytes are never rebuilt.
          db.exec(createForgeInboxPatchRequestsTableSql())
        }
        db.pragma(`user_version = ${FORGE_INBOX_SCHEMA_VERSION}`)
      })
    }
    const owner = db.prepare("SELECT value FROM meta WHERE key = 'host_id'").get()
    const hostId = owner?.value
    if (typeof hostId !== 'string' || hostId === '') {
      throw new ForgeInboxCorruptError(`forge inbox ${dbPath} has no owner host`)
    }
    if (requestedHostId !== undefined && hostId !== requestedHostId) {
      throw new ForgeInboxHostMismatchError(`forge inbox ${dbPath} belongs to another host`)
    }
    hardenSqliteDatabaseFiles(dbPath)
    return { db, hostId }
  } catch (error) {
    db.close()
    throw error
  }
}

function hasSchemaObjects(db: Database.Database): boolean {
  return db.prepare('SELECT 1 AS found FROM sqlite_master LIMIT 1').get() !== undefined
}

export function runForgeTransaction<T>(db: Database.Database, run: () => T): T {
  const signal = forgeCommitSignal(db)
  db.exec('BEGIN IMMEDIATE')
  let result: T
  try {
    signal.begin()
    result = run()
    if (result instanceof Promise) {
      throw new Error('a forge inbox transaction must not await')
    }
    db.exec('COMMIT')
  } catch (error) {
    signal.abandon()
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        console.warn('[forge-inbox] rolling back a failed transaction failed', rollbackError)
      }
    }
    throw error
  }
  signal.committed()
  return result
}

/** Read-only validation before any persistent pragma, so a damaged file is left byte-identical. */
function assertForgeInboxIntact(db: Database.Database, dbPath: string, version: number): void {
  const check = db.pragma('quick_check', { simple: true })
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  )
  const expectedTables = version === 1 ? FORGE_INBOX_V1_TABLES : FORGE_INBOX_TABLES
  const missing = expectedTables.filter((name) => !tables.has(name))
  if (check !== 'ok' || missing.length > 0) {
    throw new ForgeInboxCorruptError(
      `forge inbox ${dbPath} failed validation (${check === 'ok' ? `missing ${missing.join(', ')}` : String(check)})`
    )
  }
  const owner = db.prepare("SELECT value FROM meta WHERE key = 'host_id'").get()
  if (typeof owner?.value !== 'string' || owner.value === '') {
    throw new ForgeInboxCorruptError(`forge inbox ${dbPath} has no owner host`)
  }
  // A pre-release file that lacks a released table, column or index is refused, not migrated.
  assertForgeInboxShape(db, dbPath, version)
}

type ForgeInboxShape = {
  objects: string[]
  columns: Map<string, string>
}

const forgeInboxShapes = new Map<number, ForgeInboxShape>()

function assertForgeInboxShape(db: Database.Database, dbPath: string, version: number): void {
  const expected = expectedForgeInboxShape(version)
  const objects = new Set(forgeInboxSchemaObjects(db))
  const missing = expected.objects.filter((object) => !objects.has(object))
  if (missing.length > 0) {
    throw new ForgeInboxCorruptError(
      `forge inbox ${dbPath} has an outdated schema ${version} shape (missing ${missing.join(', ')})`
    )
  }
  for (const [table, columns] of expected.columns) {
    if (forgeInboxTableColumns(db, table) !== columns) {
      throw new ForgeInboxCorruptError(`forge inbox ${dbPath} has an outdated ${table} table`)
    }
  }
}

function expectedForgeInboxShape(version: number): ForgeInboxShape {
  const cached = forgeInboxShapes.get(version)
  if (cached) {
    return cached
  }
  const reference = new Database(':memory:')
  try {
    reference.exec(version === 1 ? FORGE_INBOX_V1_TABLES_SQL : createForgeInboxTablesSql())
    const tables: readonly string[] = version === 1 ? FORGE_INBOX_V1_TABLES : FORGE_INBOX_TABLES
    const shape: ForgeInboxShape = {
      objects: forgeInboxSchemaObjects(reference),
      columns: new Map<string, string>(
        tables.map((table) => [table, forgeInboxTableColumns(reference, table)])
      )
    }
    forgeInboxShapes.set(version, shape)
    return shape
  } finally {
    reference.close()
  }
}

/** User objects only: SQLite's own sqlite_sequence/autoindex entries follow the stored schema. */
function forgeInboxSchemaObjects(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT type || ':' || name AS object FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY object`
    )
    .all()
    .map((row) => String(row.object))
}

function forgeInboxTableColumns(db: Database.Database, table: string): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)
         ORDER BY cid`
      )
      .all(table)
  )
}
