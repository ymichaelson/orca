import { createForgeInboxV12TablesSql } from './forge-inbox-schema-run-dispatch-turn'

// SQLite cannot alter a CHECK, so items is rebuilt; run it with foreign keys off, inside the migration transaction.
export function migrateForgeInboxToV13Sql(): string {
  return `
CREATE TABLE items_v13 (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'merge_request', 'pipeline', 'project')),
  iid INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  head_order REAL NOT NULL,
  activity_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (host_id, instance_id, project_id, kind, iid)
);
INSERT INTO items_v13 (id, host_id, instance_id, project_id, kind, iid, title, state,
  current_revision, head_order, activity_seq, created_at, updated_at)
  SELECT id, host_id, instance_id, project_id, kind, iid, title, state,
    current_revision, head_order, activity_seq, created_at, updated_at FROM items;
DROP TABLE items;
ALTER TABLE items_v13 RENAME TO items;
CREATE INDEX items_by_activity ON items (host_id, instance_id, activity_seq);
`
}

export function createForgeInboxV13TablesSql(): string {
  return `${createForgeInboxV12TablesSql()}\n${migrateForgeInboxToV13Sql()}`
}
