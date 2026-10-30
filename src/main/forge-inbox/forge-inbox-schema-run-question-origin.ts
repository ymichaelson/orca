import { createForgeInboxV17TablesSql } from './forge-inbox-schema-item-archive'

export function migrateForgeInboxToV18Sql(): string {
  return `ALTER TABLE runs ADD COLUMN origin_question_id INTEGER REFERENCES project_event_questions (id);`
}

export function createForgeInboxV18TablesSql(): string {
  return `${createForgeInboxV17TablesSql()}\n${migrateForgeInboxToV18Sql()}`
}
