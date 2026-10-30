import { createForgeInboxV16TablesSql } from './forge-inbox-schema-run-terminal'

// Archiving is one reader's presentation choice: it records the item activity it was archived at,
// so newer activity brings the item back without touching the shared ledger or other readers.
export function migrateForgeInboxToV17Sql(): string {
  return `
CREATE TABLE IF NOT EXISTS item_archives (
  client_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items (id),
  archived_seq INTEGER NOT NULL,
  PRIMARY KEY (client_id, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS item_archives_by_item ON item_archives (item_id);
`
}

export function createForgeInboxV17TablesSql(): string {
  return `${createForgeInboxV16TablesSql()}\n${migrateForgeInboxToV17Sql()}`
}
