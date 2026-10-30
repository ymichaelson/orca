import { createForgeInboxV9TablesSql } from './forge-inbox-project-event-question-schema'

// A rotation retires the live envelope into these columns for a bounded window, so callbacks
// GitLab already sent keep authenticating without leaving two secrets live forever.
export function migrateForgeInboxToV10Sql(): string {
  return `
ALTER TABLE project_bindings ADD COLUMN previous_secret_protection TEXT
  CHECK (previous_secret_protection IN ('sealed', 'plaintext'));
ALTER TABLE project_bindings ADD COLUMN previous_secret_gap TEXT;
ALTER TABLE project_bindings ADD COLUMN previous_secret_envelope BLOB;
ALTER TABLE project_bindings ADD COLUMN previous_secret_expires_at INTEGER;
`
}

export function createForgeInboxV10TablesSql(): string {
  return `${createForgeInboxV9TablesSql()}\n${migrateForgeInboxToV10Sql()}`
}
