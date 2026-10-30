import Database from '../sqlite/sync-database'
import {
  createForgeInboxV3TablesSql,
  createForgeInboxV4TablesSql,
  createForgeInboxV5TablesSql,
  createForgeInboxV6TablesSql,
  createForgeInboxV7TablesSql,
  createForgeInboxV8TablesSql,
  FORGE_INBOX_TABLES,
  FORGE_INBOX_V4_TABLES,
  FORGE_INBOX_V1_TABLES,
  FORGE_INBOX_V1_TABLES_SQL,
  FORGE_INBOX_V2_TABLES,
  FORGE_INBOX_V2_TABLES_SQL
} from './forge-inbox-schema'
import {
  createForgeInboxV9TablesSql,
  FORGE_INBOX_V9_TABLES
} from './forge-inbox-project-event-question-schema'
import { createForgeInboxV10TablesSql } from './forge-inbox-schema-project-binding-secret-window'
import { createForgeInboxV11TablesSql } from './forge-inbox-schema-question-subject'
import { createForgeInboxV12TablesSql } from './forge-inbox-schema-run-dispatch-turn'
import { createForgeInboxV13TablesSql } from './forge-inbox-schema-project-item-kind'
import { createForgeInboxV14TablesSql } from './forge-inbox-schema-dispatch-confirmation'
import { createForgeInboxV15TablesSql } from './forge-inbox-schema-run-cancellation'
import { createForgeInboxV16TablesSql } from './forge-inbox-schema-run-terminal'
import { createForgeInboxV17TablesSql } from './forge-inbox-schema-item-archive'
import { createForgeInboxV18TablesSql } from './forge-inbox-schema-run-question-origin'
import { createForgeInboxV19TablesSql } from './forge-inbox-schema-question-source'

/** Read-only validation before any persistent pragma, so a damaged file is left byte-identical. */
export function forgeInboxStorageProblem(
  db: Database.Database,
  dbPath: string,
  version: number
): string | null {
  const check = db.pragma('quick_check', { simple: true })
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  )
  const expectedTables =
    version === 9
      ? FORGE_INBOX_V9_TABLES
      : version === 1
        ? FORGE_INBOX_V1_TABLES
        : version === 2
          ? FORGE_INBOX_V2_TABLES
          : version === 3 || version === 4
            ? FORGE_INBOX_V4_TABLES
            : FORGE_INBOX_TABLES
  const missing = expectedTables.filter((name) => !tables.has(name))
  if (check !== 'ok' || missing.length > 0) {
    return `forge inbox ${dbPath} failed validation (${check === 'ok' ? `missing ${missing.join(', ')}` : String(check)})`
  }
  const owner = db.prepare("SELECT value FROM meta WHERE key = 'host_id'").get()
  if (typeof owner?.value !== 'string' || owner.value === '') {
    return `forge inbox ${dbPath} has no owner host`
  }
  // A pre-release file that lacks a released table, column or index is refused, not migrated.
  return forgeInboxShapeProblem(db, dbPath, version)
}

type ForgeInboxShape = {
  objects: string[]
  columns: Map<string, string>
}

const forgeInboxShapes = new Map<number, ForgeInboxShape>()

function forgeInboxShapeProblem(
  db: Database.Database,
  dbPath: string,
  version: number
): string | null {
  const expected = expectedForgeInboxShape(version)
  const objects = new Set(forgeInboxSchemaObjects(db))
  const missing = expected.objects.filter((object) => !objects.has(object))
  if (missing.length > 0) {
    return `forge inbox ${dbPath} has an outdated schema ${version} shape (missing ${missing.join(', ')})`
  }
  for (const [table, columns] of expected.columns) {
    if (forgeInboxTableColumns(db, table) !== columns) {
      return `forge inbox ${dbPath} has an outdated ${table} table`
    }
  }
  return null
}

function expectedForgeInboxShape(version: number): ForgeInboxShape {
  const cached = forgeInboxShapes.get(version)
  if (cached) {
    return cached
  }
  const reference = new Database(':memory:')
  try {
    reference.exec(
      version === 1
        ? FORGE_INBOX_V1_TABLES_SQL
        : version === 2
          ? FORGE_INBOX_V2_TABLES_SQL
          : version === 3
            ? createForgeInboxV3TablesSql()
            : version === 4
              ? createForgeInboxV4TablesSql()
              : version === 5
                ? createForgeInboxV5TablesSql()
                : version === 6
                  ? createForgeInboxV6TablesSql()
                  : version === 7
                    ? createForgeInboxV7TablesSql()
                    : version === 8
                      ? createForgeInboxV8TablesSql()
                      : version === 9
                        ? createForgeInboxV9TablesSql()
                        : version === 10
                          ? createForgeInboxV10TablesSql()
                          : version === 11
                            ? createForgeInboxV11TablesSql()
                            : version === 12
                              ? createForgeInboxV12TablesSql()
                              : version === 13
                                ? createForgeInboxV13TablesSql()
                                : version === 14
                                  ? createForgeInboxV14TablesSql()
                                  : version === 15
                                    ? createForgeInboxV15TablesSql()
                                    : version === 16
                                      ? createForgeInboxV16TablesSql()
                                      : version === 17
                                        ? createForgeInboxV17TablesSql()
                                        : version === 18
                                          ? createForgeInboxV18TablesSql()
                                          : createForgeInboxV19TablesSql()
    )
    const tables: readonly string[] =
      version === 9
        ? FORGE_INBOX_V9_TABLES
        : version === 1
          ? FORGE_INBOX_V1_TABLES
          : version === 2
            ? FORGE_INBOX_V2_TABLES
            : version === 3 || version === 4
              ? FORGE_INBOX_V4_TABLES
              : FORGE_INBOX_TABLES
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
