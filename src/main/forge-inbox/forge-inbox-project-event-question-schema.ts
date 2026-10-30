import { createForgeInboxV8TablesSql, FORGE_INBOX_TABLES } from './forge-inbox-schema'

export const FORGE_INBOX_V9_TABLES = [...FORGE_INBOX_TABLES, 'project_event_questions'] as const

// One row per dispatch round: the question is host-written, the answer is untrusted user text.
export function createForgeInboxProjectEventQuestionsTableSql(): string {
  return `
CREATE TABLE IF NOT EXISTS project_event_questions (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL,
  decision_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
  answer TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER,
  UNIQUE (decision_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_event_questions_one_open ON project_event_questions (delivery_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS project_event_questions_open ON project_event_questions (host_id, status, id);
`
}

export function migrateForgeInboxToV9Sql(): string {
  return createForgeInboxProjectEventQuestionsTableSql()
}

export function createForgeInboxV9TablesSql(): string {
  return `${createForgeInboxV8TablesSql()}\n${migrateForgeInboxToV9Sql()}`
}
