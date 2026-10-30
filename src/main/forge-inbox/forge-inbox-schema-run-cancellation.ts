import { createForgeInboxV14TablesSql } from './forge-inbox-schema-dispatch-confirmation'

// A policy change asks a running dispatch to stop; the run keeps its state until the agent's own turn proves how it ended.
export function migrateForgeInboxToV15Sql(): string {
  return `
ALTER TABLE runs ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE runs ADD COLUMN cancel_operation_id TEXT;
ALTER TABLE runs ADD COLUMN cancel_policy_generation INTEGER;
ALTER TABLE runs ADD COLUMN cancel_delivery TEXT;
ALTER TABLE runs ADD COLUMN cancel_fence INTEGER;
CREATE INDEX IF NOT EXISTS runs_cancel_requested ON runs (id) WHERE cancel_requested_at IS NOT NULL;
`
}

export function createForgeInboxV15TablesSql(): string {
  return `${createForgeInboxV14TablesSql()}\n${migrateForgeInboxToV15Sql()}`
}
