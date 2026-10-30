import { createForgeInboxV13TablesSql } from './forge-inbox-schema-project-item-kind'

// What a dispatched agent did on GitLab is unknown until the host checks it, so each run owns one verdict row.
export function migrateForgeInboxToV14Sql(): string {
  return `
CREATE TABLE IF NOT EXISTS run_dispatch_confirmations (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id),
  host_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed', 'contradicted', 'unconfirmable', 'no-claim')),
  binding_id TEXT NOT NULL,
  gitlab_host TEXT NOT NULL,
  gitlab_project_id INTEGER NOT NULL,
  item_kind TEXT NOT NULL,
  item_iid INTEGER NOT NULL,
  expected_sha TEXT,
  marker TEXT NOT NULL,
  session_id TEXT,
  client_message_id TEXT,
  turn_id TEXT,
  report_json TEXT CHECK (report_json IS NULL OR length(CAST(report_json AS BLOB)) <= 8192),
  evidence_json TEXT CHECK (evidence_json IS NULL OR length(CAST(evidence_json AS BLOB)) <= 8192),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_dispatch_confirmations_by_state ON run_dispatch_confirmations (host_id, state);
`
}

export function createForgeInboxV14TablesSql(): string {
  return `${createForgeInboxV13TablesSql()}\n${migrateForgeInboxToV14Sql()}`
}
