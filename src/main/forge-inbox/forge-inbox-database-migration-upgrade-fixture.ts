import { expect } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import {
  V1_SCHEMA_SQL,
  V3_WEBHOOK_DELIVERY_COLUMNS
} from './forge-inbox-database-migration-v1-fixture'

const V1_TABLES = [
  'meta',
  'policies',
  'instance_origins',
  'credentials',
  'changes',
  'items',
  'item_revisions',
  'deliveries',
  'webhook_deliveries',
  'project_invalidations',
  'events',
  'runs',
  'proposals',
  'receipts',
  'item_reads',
  'client_cursors'
] as const

// Frozen at the shipped columns so an additive column never rewrites a preserved row's snapshot.
const V1_RUN_COLUMNS = [
  'id',
  'item_id',
  'revision',
  'state',
  'generation',
  'policy_generation',
  'context_digest',
  'analysis_kind',
  'reason',
  'error',
  'session_id',
  'result_json',
  'created_at',
  'updated_at'
] as const

// Released schema 2 is v1 plus patch_requests, frozen verbatim so migration is proved against the
// shape that shipped rather than whatever the current builder emits.
export const V2_PATCH_REQUESTS_SQL = `
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

export const V2_SCHEMA_SQL = `${V1_SCHEMA_SQL}\n${V2_PATCH_REQUESTS_SQL}`

// Released schema 3 is v2 plus the project event tables, frozen verbatim for the same reason.
export const V3_PROJECT_EVENT_SQL = `
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

CREATE TABLE project_event_policies (
  host_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, repo_id)
) WITHOUT ROWID;

CREATE TABLE project_event_repo_links (
  host_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, repo_id),
  UNIQUE (binding_id)
) WITHOUT ROWID;
`

export const V3_SCHEMA_SQL = `${V2_SCHEMA_SQL}\n${V3_PROJECT_EVENT_SQL}`

const SEED_SQL = `
INSERT INTO meta (key, value) VALUES ('host_id', 'host-a'), ('config_revision', '7');
INSERT INTO policies (instance_id, project_id, generation) VALUES ('gitlab-main', 'group/repo', 3);
INSERT INTO instance_origins (instance_id, base_url) VALUES ('gitlab-main', 'https://gitlab.example');
INSERT INTO credentials (instance_id, kind, protection, gap, envelope, updated_at)
  VALUES ('gitlab-main', 'api-write', 'plaintext', NULL, X'00deadbeef01', 111);
INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
  current_revision, head_order, activity_seq, created_at, updated_at)
  VALUES (1, 'host-a', 'gitlab-main', 'group/repo', 'merge_request', 7, 'Add thing', 'opened',
    2, 10.5, 5, 100, 200);
INSERT INTO item_revisions (id, item_id, revision, version_token, source_order, created_at)
  VALUES (1, 1, 1, 'v1', 10.5, 100), (2, 1, 2, 'v2', 20.5, 200);
INSERT INTO changes (seq, host_id, instance_id, item_id, entity, entity_id, change, created_at)
  VALUES (1, 'host-a', 'gitlab-main', 1, 'item', 1, 'upserted', 222);
INSERT INTO deliveries (host_id, instance_id, dedupe_key, event_id, received_at)
  VALUES ('host-a', 'gitlab-main', 'delivery-1', 1, 100);
INSERT INTO project_invalidations (host_id, instance_id, project_id, generation)
  VALUES ('host-a', 'gitlab-main', 'group/repo', 4);
INSERT INTO webhook_deliveries (id, host_id, instance_id, project_id, dedupe_key, event_kind,
  event_uuid, config_uuid, config_revision, admitted_at, state, attempts, next_attempt_at,
  last_error_code, finished_at, body)
  VALUES (1, 'host-a', 'gitlab-main', 'group/repo', 'delivery-1', 'merge_request.updated',
    NULL, NULL, 7, 100, 'done', 1, NULL, NULL, 150, X'0102ff');
INSERT INTO events (id, item_id, revision, event_kind, version_token, source_order, payload_json,
  received_at)
  VALUES (1, 1, 1, 'merge_request.updated', 'v1', 10.5, '{"n":1}', 100);
INSERT INTO runs (id, item_id, revision, state, generation, policy_generation, context_digest,
  analysis_kind, reason, error, session_id, result_json, created_at, updated_at)
  VALUES (1, 1, 2, 'succeeded', 5, 3, 'digest-1', 'review', 'x', NULL, 'session-1', '{"ok":true}',
    100, 200);
INSERT INTO proposals (id, run_id, item_id, revision, policy_generation, status, body_json,
  created_at, resolved_at)
  VALUES (1, 1, 1, 2, 3, 'pending', '{"comment":"hi"}', 200, NULL);
INSERT INTO receipts (id, proposal_id, idempotency_key, state, result_json, created_at, updated_at)
  VALUES (1, 1, 'idem-1', 'pending', NULL, 200, 200);
INSERT INTO item_reads (client_id, item_id, read_seq) VALUES ('client-1', 1, 5);
INSERT INTO client_cursors (client_id, host_id, instance_id, last_seq)
  VALUES ('client-1', 'host-a', 'gitlab-main', 5);
`

type OpenDatabase = ReturnType<typeof openForgeInboxDatabase>['db']

export function columnNames(db: OpenDatabase, table: string): string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name))
}

export function snapshot(db: OpenDatabase): Record<string, string[]> {
  return Object.fromEntries(
    V1_TABLES.map((table) => [
      table,
      db
        .prepare(
          `SELECT ${
            table === 'webhook_deliveries'
              ? V3_WEBHOOK_DELIVERY_COLUMNS.join(', ')
              : table === 'runs'
                ? V1_RUN_COLUMNS.join(', ')
                : '*'
          } FROM ${table}`
        )
        .all()
        .map((row) => JSON.stringify(row))
        .sort()
    ])
  )
}

export function rawVersion(path: string): number {
  const db = new Database(path)
  try {
    return Number(db.pragma('user_version', { simple: true }) ?? 0)
  } finally {
    db.close()
  }
}

export function rawState(path: string): { version: number; snapshot: Record<string, string[]> } {
  const db = new Database(path)
  try {
    return {
      version: Number(db.pragma('user_version', { simple: true }) ?? 0),
      snapshot: snapshot(db)
    }
  } finally {
    db.close()
  }
}

export function expectV8PolicyTriggerAndDeliveryIndex(db: Database.Database): void {
  const trigger = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger'
       AND name = 'project_event_policy_decision_invalidation'`
    )
    .get()
  expect(typeof trigger?.sql).toBe('string')
  expect(String(trigger?.sql)).toContain("'policy-disabled'")
  expect(String(trigger?.sql)).toContain('finished_at = CASE')
  expect(
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index'
         AND name = 'project_event_decisions_delivery'`
      )
      .get()
  ).toEqual({ name: 'project_event_decisions_delivery' })
}

export function createV1(dbPath: string, sql = V1_SCHEMA_SQL, seed = true): void {
  const db = new Database(dbPath)
  try {
    db.exec(sql)
    if (seed) {
      db.exec(SEED_SQL)
    }
    db.pragma('user_version = 1')
  } finally {
    db.close()
  }
}

export function createV2(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(V2_SCHEMA_SQL)
    db.exec(SEED_SQL)
    db.pragma('user_version = 2')
  } finally {
    db.close()
  }
}

export function createV3(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(V3_SCHEMA_SQL)
    db.exec(SEED_SQL)
    db.pragma('user_version = 3')
  } finally {
    db.close()
  }
}

export function openLedger(dbPath: string) {
  const opened = openForgeInboxDatabase(dbPath, 'host-a')
  return { ...opened, snapshot: snapshot(opened.db) }
}
