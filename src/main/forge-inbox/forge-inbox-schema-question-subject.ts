import { createForgeInboxV10TablesSql } from './forge-inbox-schema-project-binding-secret-window'

// The fixed facts ride beside the stored sentence so a client renders the question in its locale.
export function migrateForgeInboxToV11Sql(): string {
  return `
ALTER TABLE project_event_questions ADD COLUMN subject_kind TEXT;
ALTER TABLE project_event_questions ADD COLUMN subject_iid INTEGER;
ALTER TABLE project_event_questions ADD COLUMN subject_title TEXT;
`
}

export function createForgeInboxV11TablesSql(): string {
  return `${createForgeInboxV10TablesSql()}\n${migrateForgeInboxToV11Sql()}`
}
