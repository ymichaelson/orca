import { createForgeInboxV18TablesSql } from './forge-inbox-schema-run-question-origin'

// A question that a preparation could not ask yet says why, and how often it was tried.
export function migrateForgeInboxToV19Sql(): string {
  return `ALTER TABLE project_event_questions ADD COLUMN source TEXT;
CREATE TABLE IF NOT EXISTS project_event_question_attempts (
  delivery_id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);`
}

export function createForgeInboxV19TablesSql(): string {
  return `${createForgeInboxV18TablesSql()}\n${migrateForgeInboxToV19Sql()}`
}
