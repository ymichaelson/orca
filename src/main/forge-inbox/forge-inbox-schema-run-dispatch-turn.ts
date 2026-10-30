import { createForgeInboxV11TablesSql } from './forge-inbox-schema-question-subject'

// The dispatched turn names its own journal entry, so a restart can query it instead of guessing.
export function migrateForgeInboxToV12Sql(): string {
  return `
ALTER TABLE runs ADD COLUMN dispatch_client_message_id TEXT;
`
}

export function createForgeInboxV12TablesSql(): string {
  return `${createForgeInboxV11TablesSql()}\n${migrateForgeInboxToV12Sql()}`
}
