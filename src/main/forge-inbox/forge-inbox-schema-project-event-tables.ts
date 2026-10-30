import { FORGE_INBOX_V2_TABLES_SQL } from './forge-inbox-schema-base-tables'

// Frozen at the shipped version 3: the v4 rebuild starts from this text, so its own shape stays fixed.
export function createForgeInboxV3TablesSql(): string {
  return `${FORGE_INBOX_V2_TABLES_SQL}\n${createForgeInboxProjectEventTablesSql()}`
}

export function createForgeInboxProjectEventTablesSql(): string {
  return `${createForgeInboxProjectBindingsTableSql()}\n${createForgeInboxProjectEventPoliciesTableSql()}\n${createForgeInboxProjectEventRepoLinksTableSql()}`
}

/**
 * A delivery row is owned by exactly one subject: a project binding for the current flow, or the
 * retired instance for rows admitted before it. The XOR makes the two impossible to conflate.
 */

/**
 * A delivery row is owned by exactly one subject: a project binding for the current flow, or the
 * retired instance for rows admitted before it. The XOR makes the two impossible to conflate.
 */
export function createForgeInboxWebhookDeliveriesV4Sql(): string {
  return `
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  instance_id TEXT,
  binding_id TEXT,
  project_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_uuid TEXT,
  config_uuid TEXT,
  config_revision INTEGER,
  policy_generation INTEGER,
  admitted_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'parked', 'done', 'failed', 'needs-auth')),
  parked_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  finished_at INTEGER,
  body BLOB NOT NULL,
  CHECK ((instance_id IS NOT NULL) <> (binding_id IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_deliveries_instance_dedupe
  ON webhook_deliveries (host_id, instance_id, dedupe_key) WHERE instance_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_deliveries_binding_dedupe
  ON webhook_deliveries (host_id, binding_id, dedupe_key) WHERE binding_id IS NOT NULL;
CREATE INDEX webhook_deliveries_claim ON webhook_deliveries (host_id, state, next_attempt_at, id);
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (host_id, finished_at)
  WHERE finished_at IS NOT NULL;
`
}

/** v3 to v4: the same rows, with the subject split so binding deliveries can carry their policy. */
export function migrateForgeInboxToV4Sql(): string {
  return `
DROP INDEX webhook_deliveries_claim;
DROP INDEX webhook_deliveries_finished;
ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_v3;
${createForgeInboxWebhookDeliveriesV4Sql()}
INSERT INTO webhook_deliveries (id, host_id, instance_id, binding_id, project_id, dedupe_key,
  event_kind, event_uuid, config_uuid, config_revision, policy_generation, admitted_at, state,
  parked_reason, attempts, next_attempt_at, last_error_code, finished_at, body)
SELECT id, host_id, instance_id, NULL, project_id, dedupe_key, event_kind, event_uuid, config_uuid,
  config_revision, NULL, admitted_at, state, NULL, attempts, next_attempt_at, last_error_code,
  finished_at, body FROM webhook_deliveries_v3;
DROP TABLE webhook_deliveries_v3;
`
}

/** Fresh installs build the same v4 shape by running the same migration over the v3 text. */
export function createForgeInboxV4TablesSql(): string {
  return `${createForgeInboxV3TablesSql()}\n${migrateForgeInboxToV4Sql()}`
}

/** One decision per binding delivery. The action is the only thing the model was allowed to return. */
export function createForgeInboxProjectEventDecisionsTableSql(): string {
  return `
CREATE TABLE project_event_decisions (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL UNIQUE REFERENCES webhook_deliveries (id),
  policy_generation INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('jev', 'laya')),
  model TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('record_only', 'notify', 'wait', 'fetch_context', 'dispatch_agent', 'ask_user')),
  confidence REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  decided_at INTEGER NOT NULL
);
`
}

export function createForgeInboxV5TablesSql(): string {
  return `${createForgeInboxV4TablesSql()}\n${createForgeInboxProjectEventDecisionsTableSql()}`
}

// One managed project hook per GitLab project: the binding ties the execution host's Orca project to
// its GitLab identity, the remote hook id, connection state and the per-binding webhook secret.
export function createForgeInboxProjectBindingsTableSql(): string {
  return `
CREATE TABLE project_bindings (
  binding_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  gitlab_host TEXT NOT NULL,
  gitlab_path TEXT NOT NULL,
  gitlab_project_id INTEGER NOT NULL,
  callback_url TEXT NOT NULL,
  hook_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('unconfigured', 'checking', 'registering', 'verifying', 'connected', 'failed')),
  failure_phase TEXT CHECK (failure_phase IN ('checking', 'registering', 'verifying')),
  failure_code TEXT,
  failed_at INTEGER,
  retryable INTEGER NOT NULL DEFAULT 0,
  secret_protection TEXT CHECK (secret_protection IN ('sealed', 'plaintext')),
  secret_gap TEXT,
  secret_envelope BLOB,
  rejected_events_json TEXT,
  pending_secret_protection TEXT CHECK (pending_secret_protection IN ('sealed', 'plaintext')),
  pending_secret_gap TEXT,
  pending_secret_envelope BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (gitlab_host, gitlab_project_id)
) WITHOUT ROWID;
`
}

// One policy per repository, not per worktree: every checkout of the repo shares the same events,
// budgets and rules. workspace_id is deliberately absent so a new worktree inherits the policy.
export function createForgeInboxProjectEventPoliciesTableSql(): string {
  return `
CREATE TABLE project_event_policies (
  host_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, repo_id)
) WITHOUT ROWID;
`
}

// A repository owns at most one binding, and a binding belongs to at most one repository.
export function createForgeInboxProjectEventRepoLinksTableSql(): string {
  return `
CREATE TABLE project_event_repo_links (
  host_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, repo_id),
  UNIQUE (binding_id)
) WITHOUT ROWID;
`
}
