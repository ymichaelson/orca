import { createForgeInboxV19TablesSql } from './forge-inbox-schema-question-source'

/** A policy question names its repository and the reader's choice, never the answer as prompt text. */
export function migrateForgeInboxToV20Sql(): string {
  return `ALTER TABLE project_event_questions ADD COLUMN policy_repo_id TEXT;`
}

export function createForgeInboxV20TablesSql(): string {
  return `${createForgeInboxV19TablesSql()}\n${migrateForgeInboxToV20Sql()}`
}
