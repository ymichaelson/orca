import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  ForgeInboxCorruptError,
  ForgeInboxHostMismatchError,
  ForgeInboxSchemaError,
  openForgeInboxDatabase
} from './forge-inbox-database'

// Released schema 1, copied verbatim from b64c52f517 so the migration is proved against the shape
// that shipped, not against whatever the current builder emits.
const V1_SCHEMA_SQL = `
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

function columnNames(db: OpenDatabase, table: string): string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name))
}

function snapshot(db: OpenDatabase): Record<string, string[]> {
  return Object.fromEntries(
    V1_TABLES.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort()
    ])
  )
}

function rawVersion(path: string): number {
  const db = new Database(path)
  try {
    return Number(db.pragma('user_version', { simple: true }) ?? 0)
  } finally {
    db.close()
  }
}

function rawState(path: string): { version: number; snapshot: Record<string, string[]> } {
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

describe('forge inbox ledger schema migration', () => {
  let root: string
  let dbPath: string

  const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex')

  function createV1(sql = V1_SCHEMA_SQL, seed = true): void {
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

  function open() {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    return { ...opened, snapshot: snapshot(opened.db) }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-schema-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('migrates a released version-1 ledger to version 2 preserving every row and credential byte', () => {
    createV1()
    const before = rawState(dbPath)

    const opened = open()
    try {
      expect(opened.hostId).toBe('host-a')
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(2)
      expect(opened.snapshot).toEqual(before.snapshot)
      expect(columnNames(opened.db, 'patch_requests')).toEqual([
        'id',
        'caller_key',
        'operation_id',
        'request_digest',
        'run_id',
        'run_generation',
        'session_id',
        'item_id',
        'revision',
        'policy_generation',
        'config_revision',
        'invalidation_generation',
        'state',
        'proposal_id',
        'reason_code',
        'created_at',
        'updated_at'
      ])

      const reopened = open()
      reopened.db.close()
      expect(reopened.snapshot).toEqual(before.snapshot)
      expect(reopened.hostId).toBe('host-a')
    } finally {
      opened.db.close()
    }
  })

  it('creates a version-2 ledger with a data-only patch_requests table on first open', () => {
    const opened = openForgeInboxDatabase(dbPath)
    try {
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(2)
      expect(columnNames(opened.db, 'patch_requests')).toHaveLength(17)
      expect(
        opened.db.prepare("SELECT type FROM sqlite_master WHERE name = 'patch_requests'").get()
          ?.type
      ).toBe('table')

      const foreignKeys = opened.db.pragma('foreign_key_list(patch_requests)')
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'run_id', table: 'runs' }),
          expect.objectContaining({ from: 'item_id', table: 'items' }),
          expect.objectContaining({ from: 'proposal_id', table: 'proposals' })
        ])
      )
      expect(foreignKeys).toHaveLength(3)
    } finally {
      opened.db.close()
    }
  })

  it('keeps request state, identity and proposal bindings constrained', () => {
    const { db } = openForgeInboxDatabase(dbPath)
    try {
      db.exec(`
        INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
          current_revision, head_order, activity_seq, created_at, updated_at)
          VALUES (1, 'host-a', 'gitlab-main', 'group/repo', 'merge_request', 7, 't', 'opened',
            1, 1, 1, 1, 1);
        INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
          context_digest, analysis_kind, reason, created_at, updated_at)
          VALUES (1, 1, 1, 'succeeded', 2, 3, 'd', 'review', 'r', 1, 1);
        INSERT INTO proposals (id, run_id, item_id, revision, policy_generation, status, body_json,
          created_at)
          VALUES (1, 1, 1, 1, 3, 'pending', '{}', 1);
      `)
      const insert = (
        operationId: string,
        state: string,
        proposalId: number | null,
        sessionId: string | null = 'session-1'
      ) =>
        db
          .prepare(
            `INSERT INTO patch_requests (caller_key, operation_id, request_digest, run_id,
              run_generation, session_id, item_id, revision, policy_generation, config_revision,
              invalidation_generation, state, proposal_id, reason_code, created_at, updated_at)
             VALUES ('caller', ?, 'digest', 1, 2, ?, 1, 1, 3, 7, 4, ?, ?, NULL, 10, 10)`
          )
          .run(operationId, sessionId, state, proposalId)

      insert('op-1', 'in_progress', null)
      expect(() => insert('op-1', 'succeeded', 1)).toThrow(/UNIQUE constraint failed/)
      expect(() => insert('op-2', 'done', 1)).toThrow(/CHECK constraint failed/)
      expect(() => insert('op-3', 'succeeded', 999)).toThrow(/FOREIGN KEY constraint failed/)
      expect(() => insert('op-4', 'in_progress', null, null)).toThrow(/NOT NULL constraint failed/)
    } finally {
      db.close()
    }
  })

  it('refuses a migrated patch request without a bound session', () => {
    createV1()
    const { db } = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO patch_requests (caller_key, operation_id, request_digest, run_id,
              run_generation, session_id, item_id, revision, policy_generation, config_revision,
              invalidation_generation, state, proposal_id, reason_code, created_at, updated_at)
             VALUES ('caller', 'op-1', 'digest', 1, 5, NULL, 1, 2, 3, 7, 4, 'in_progress',
               NULL, NULL, 10, 10)`
          )
          .run()
      ).toThrow(/NOT NULL constraint failed/)
    } finally {
      db.close()
    }
  })

  it('refuses a version-1 file with a missing released column before migrating it', () => {
    createV1()
    const older = new Database(dbPath)
    older.exec('ALTER TABLE items DROP COLUMN head_order')
    older.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxCorruptError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(1)
    const untouched = new Database(dbPath)
    try {
      expect(
        untouched.prepare("SELECT 1 FROM sqlite_master WHERE name = 'patch_requests'").get()
      ).toBeUndefined()
    } finally {
      untouched.close()
    }
  })

  it('refuses a version-2 file without patch_requests before touching it', () => {
    createV1()
    const raw = new Database(dbPath)
    raw.pragma('user_version = 2')
    raw.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxCorruptError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(2)
  })

  it('refuses a negative stored schema version before any persistent pragma or migration', () => {
    createV1()
    const raw = new Database(dbPath)
    raw.pragma('user_version = -1')
    raw.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxSchemaError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(-1)
    const untouched = new Database(dbPath)
    try {
      expect(
        untouched.prepare("SELECT 1 FROM sqlite_master WHERE name = 'patch_requests'").get()
      ).toBeUndefined()
    } finally {
      untouched.close()
    }
  })

  it('refuses an empty file with a negative stored schema version before creating anything', () => {
    const raw = new Database(dbPath)
    raw.pragma('user_version = -1')
    raw.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxSchemaError)

    expect(digest()).toBe(before)
    expect(rawVersion(dbPath)).toBe(-1)
    const untouched = new Database(dbPath)
    try {
      expect(
        untouched.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      ).toEqual([])
    } finally {
      untouched.close()
    }
  })

  it('refuses a version-1 ledger requested for another host before migrating it', () => {
    createV1()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-b')).toThrow(ForgeInboxHostMismatchError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(1)
    const untouched = new Database(dbPath)
    try {
      expect(
        untouched.prepare("SELECT 1 FROM sqlite_master WHERE name = 'patch_requests'").get()
      ).toBeUndefined()
    } finally {
      untouched.close()
    }
  })

  it('rolls back the schema DDL and version bump when the migration cannot complete', () => {
    createV1()
    const seeded = rawState(dbPath).snapshot
    const raw = new Database(dbPath)
    // A name collision makes CREATE TABLE fail inside the migration transaction.
    raw.exec('CREATE VIEW patch_requests AS SELECT 1 AS id')
    raw.close()

    // The SQLite error proves validation passed and the DDL itself failed inside the transaction.
    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(
      'view patch_requests already exists'
    )

    const afterFailure = rawState(dbPath)
    expect(afterFailure.version).toBe(1)
    expect(afterFailure.snapshot).toEqual(seeded)
    const stillView = new Database(dbPath)
    try {
      expect(
        stillView.prepare("SELECT type FROM sqlite_master WHERE name = 'patch_requests'").get()
          ?.type
      ).toBe('view')
    } finally {
      stillView.close()
    }

    const cleanup = new Database(dbPath)
    cleanup.exec('DROP VIEW patch_requests')
    cleanup.close()
    const migrated = open()
    expect(Number(migrated.db.pragma('user_version', { simple: true }))).toBe(2)
    expect(migrated.snapshot).toEqual(seeded)
    migrated.db.close()
  })
})
