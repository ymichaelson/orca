// `PRAGMA user_version` is read FIRST on a connection that has set no persistent pragma: a
// database from a newer build or a corrupt file must stay byte-identical, and WAL writes the header.

import { randomUUID } from 'node:crypto'
import Database from '../sqlite/sync-database'
import { forgeInboxStorageProblem } from './forge-inbox-database-shape'
import { forgeCommitSignal } from './forge-inbox-commit-signal'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import {
  createForgeInboxPatchRequestsTableSql,
  createForgeInboxProjectEventTablesSql,
  createForgeInboxProjectEventDecisionsTableSql,
  createForgeInboxV5TablesSql,
  FORGE_INBOX_SCHEMA_VERSION,
  migrateForgeInboxToV4Sql,
  migrateForgeInboxToV6Sql,
  migrateForgeInboxToV7Sql,
  migrateForgeInboxToV8Sql
} from './forge-inbox-schema'
import { migrateForgeInboxToV9Sql } from './forge-inbox-project-event-question-schema'
import { migrateForgeInboxToV10Sql } from './forge-inbox-schema-project-binding-secret-window'
import { migrateForgeInboxToV11Sql } from './forge-inbox-schema-question-subject'
import { migrateForgeInboxToV12Sql } from './forge-inbox-schema-run-dispatch-turn'
import { migrateForgeInboxToV13Sql } from './forge-inbox-schema-project-item-kind'
import { migrateForgeInboxToV14Sql } from './forge-inbox-schema-dispatch-confirmation'
import { migrateForgeInboxToV15Sql } from './forge-inbox-schema-run-cancellation'
import { migrateForgeInboxToV16Sql } from './forge-inbox-schema-run-terminal'
import { migrateForgeInboxToV17Sql } from './forge-inbox-schema-item-archive'
import { migrateForgeInboxToV18Sql } from './forge-inbox-schema-run-question-origin'
import { migrateForgeInboxToV19Sql } from './forge-inbox-schema-question-source'

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
      const problem = forgeInboxStorageProblem(db, dbPath, stored)
      if (problem !== null) {
        throw new ForgeInboxCorruptError(problem)
      }
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
      // The items rebuild drops a table other rows point at, and the pragma is a no-op inside a transaction.
      db.pragma('foreign_keys = OFF')
      try {
        migrateForgeInbox(db, dbPath, stored, requestedHostId)
      } finally {
        db.pragma('foreign_keys = ON')
      }
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

function migrateForgeInbox(
  db: Database.Database,
  dbPath: string,
  stored: number,
  requestedHostId: string | undefined
): void {
  // Tables and the version bump commit together so a shaped file never reports version 0.
  runForgeTransaction(db, () => {
    if (stored === 0) {
      db.exec(createForgeInboxV5TablesSql())
      db.prepare("INSERT INTO meta (key, value) VALUES ('host_id', ?)").run(
        requestedHostId ?? randomUUID()
      )
    } else if (stored === 1) {
      // v1 to v2 then v2 to v3 are additive: existing rows and credential bytes are never rebuilt.
      db.exec(createForgeInboxPatchRequestsTableSql())
      db.exec(createForgeInboxProjectEventTablesSql())
      db.exec(migrateForgeInboxToV4Sql())
      db.exec(createForgeInboxProjectEventDecisionsTableSql())
    } else if (stored === 2) {
      db.exec(createForgeInboxProjectEventTablesSql())
      db.exec(migrateForgeInboxToV4Sql())
      db.exec(createForgeInboxProjectEventDecisionsTableSql())
    } else if (stored === 3) {
      // v3 to v4 rebuilds webhook_deliveries, so keeping its rows intact is the migration itself.
      db.exec(migrateForgeInboxToV4Sql())
      db.exec(createForgeInboxProjectEventDecisionsTableSql())
    } else if (stored === 4) {
      db.exec(createForgeInboxProjectEventDecisionsTableSql())
    }
    if (stored < 6) {
      db.exec(migrateForgeInboxToV6Sql())
    }
    if (stored < 7) {
      db.exec(migrateForgeInboxToV7Sql())
    }
    if (stored < 8) {
      db.exec(migrateForgeInboxToV8Sql())
    }
    db.exec(migrateForgeInboxToV9Sql())
    if (stored < 10) {
      db.exec(migrateForgeInboxToV10Sql())
    }
    if (stored < 11) {
      db.exec(migrateForgeInboxToV11Sql())
    }
    if (stored < 12) {
      db.exec(migrateForgeInboxToV12Sql())
    }
    if (stored < 13) {
      db.exec(migrateForgeInboxToV13Sql())
    }
    if (stored < 14) {
      db.exec(migrateForgeInboxToV14Sql())
    }
    if (stored < 15) {
      db.exec(migrateForgeInboxToV15Sql())
    }
    if (stored < 16) {
      db.exec(migrateForgeInboxToV16Sql())
    }
    if (stored < 17) {
      db.exec(migrateForgeInboxToV17Sql())
    }
    if (stored < 18) {
      db.exec(migrateForgeInboxToV18Sql())
    }
    if (stored < 19) {
      db.exec(migrateForgeInboxToV19Sql())
    }
    const violations = db.pragma('foreign_key_check')
    if (Array.isArray(violations) && violations.length > 0) {
      throw new ForgeInboxCorruptError(`forge inbox ${dbPath} has rows that break a foreign key`)
    }
    db.pragma(`user_version = ${FORGE_INBOX_SCHEMA_VERSION}`)
  })
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
