// Frozen at the shipped version 1 so migration never reinterprets the old file with a new shape.
export const FORGE_INBOX_V1_TABLES_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE policies (
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (instance_id, project_id)
) WITHOUT ROWID;

CREATE TABLE instance_origins (
  instance_id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE credentials (
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'api-read', 'api-write')),
  protection TEXT NOT NULL CHECK (protection IN ('sealed', 'plaintext')),
  gap TEXT,
  envelope BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, kind)
) WITHOUT ROWID;

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  change TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX changes_by_host ON changes (host_id, instance_id, seq);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'merge_request', 'pipeline')),
  iid INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  head_order REAL NOT NULL,
  activity_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (host_id, instance_id, project_id, kind, iid)
);
CREATE INDEX items_by_activity ON items (host_id, instance_id, activity_seq);

CREATE TABLE item_revisions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  revision INTEGER NOT NULL,
  version_token TEXT NOT NULL,
  source_order REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (item_id, revision)
);

CREATE TABLE deliveries (
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, instance_id, dedupe_key)
) WITHOUT ROWID;

CREATE TABLE project_invalidations (
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (host_id, instance_id, project_id)
) WITHOUT ROWID;

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_uuid TEXT,
  config_uuid TEXT,
  config_revision INTEGER NOT NULL,
  admitted_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'needs-auth')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  finished_at INTEGER,
  body BLOB NOT NULL,
  UNIQUE (host_id, instance_id, dedupe_key)
);
CREATE INDEX webhook_deliveries_claim ON webhook_deliveries (host_id, state, next_attempt_at, id);
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (host_id, finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  revision INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  version_token TEXT NOT NULL,
  source_order REAL NOT NULL,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX events_by_item ON events (item_id, id);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'awaiting-approval', 'succeeded',
    'failed', 'cancelled', 'unverifiable', 'superseded')),
  generation INTEGER NOT NULL DEFAULT 0,
  policy_generation INTEGER NOT NULL,
  context_digest TEXT NOT NULL,
  analysis_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  error TEXT,
  session_id TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX runs_by_item ON runs (item_id, id);
CREATE UNIQUE INDEX runs_one_queued_per_item ON runs (item_id) WHERE state = 'queued';
CREATE INDEX runs_by_context ON runs (item_id, context_digest, policy_generation, analysis_kind);
CREATE UNIQUE INDEX runs_one_active_per_context ON runs (item_id, context_digest,
  policy_generation, analysis_kind) WHERE state IN ('queued', 'running');

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  item_id INTEGER NOT NULL REFERENCES items (id),
  revision INTEGER NOT NULL,
  policy_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'rejected', 'stale')),
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX proposals_by_item ON proposals (item_id, id);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'failed', 'unknown')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE item_reads (
  client_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items (id),
  read_seq INTEGER NOT NULL,
  PRIMARY KEY (client_id, item_id)
) WITHOUT ROWID;

CREATE TABLE client_cursors (
  client_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (client_id, host_id, instance_id)
) WITHOUT ROWID;
`

// Data-only request record: run_generation fences runs.generation, invalidation_generation is the
// project_invalidations generation at request time; no prompts, file bodies or secrets are stored.
export function createForgeInboxPatchRequestsTableSql(): string {
  return `
CREATE TABLE patch_requests (
  id INTEGER PRIMARY KEY,
  caller_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  run_generation INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items (id),
  revision INTEGER NOT NULL,
  policy_generation INTEGER NOT NULL,
  config_revision INTEGER NOT NULL,
  invalidation_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'succeeded', 'failed', 'unverifiable')),
  proposal_id INTEGER REFERENCES proposals (id),
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (caller_key, operation_id)
);
`
}

// Frozen at the shipped version 2 so migration never reinterprets the old file with a new shape.
export const FORGE_INBOX_V2_TABLES_SQL = `${FORGE_INBOX_V1_TABLES_SQL}\n${createForgeInboxPatchRequestsTableSql()}`
