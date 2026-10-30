import { createForgeInboxV15TablesSql } from './forge-inbox-schema-run-cancellation'

// A terminal dispatch keeps the exact PTY it started and what its process did; the Agent and model it
// was dispatched with are written once and never follow later policy changes.
export function migrateForgeInboxToV16Sql(): string {
  return `
ALTER TABLE runs ADD COLUMN terminal_handle TEXT;
ALTER TABLE runs ADD COLUMN terminal_pty_id TEXT;
ALTER TABLE runs ADD COLUMN terminal_incarnation_id TEXT;
ALTER TABLE runs ADD COLUMN terminal_execution_host_id TEXT;
ALTER TABLE runs ADD COLUMN terminal_worktree_id TEXT;
ALTER TABLE runs ADD COLUMN terminal_exit_kind TEXT;
ALTER TABLE runs ADD COLUMN terminal_exit_value INTEGER;
ALTER TABLE runs ADD COLUMN terminal_exit_at INTEGER;
ALTER TABLE runs ADD COLUMN dispatch_agent_id TEXT;
ALTER TABLE runs ADD COLUMN dispatch_requested_model TEXT;
ALTER TABLE runs ADD COLUMN dispatch_actual_model TEXT;
CREATE INDEX IF NOT EXISTS runs_terminal_open ON runs (id)
  WHERE terminal_handle IS NOT NULL AND terminal_exit_kind IS NULL;
`
}

export function createForgeInboxV16TablesSql(): string {
  return `${createForgeInboxV15TablesSql()}\n${migrateForgeInboxToV16Sql()}`
}
