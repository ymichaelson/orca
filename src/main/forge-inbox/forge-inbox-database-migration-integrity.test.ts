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
import {
  createV1 as createV1At,
  createV2 as createV2At,
  createV3 as createV3At,
  openLedger,
  rawState,
  rawVersion
} from './forge-inbox-database-migration-upgrade-fixture'
import { FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'

describe('forge inbox ledger schema migration', () => {
  let root: string
  let dbPath: string

  const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex')
  const open = () => openLedger(dbPath)
  const createV1 = () => createV1At(dbPath)
  const createV2 = () => createV2At(dbPath)
  const createV3 = () => createV3At(dbPath)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-schema-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps one repository policy and one repository link per key', () => {
    const { db } = openForgeInboxDatabase(dbPath)
    try {
      const policy = db.prepare(
        `INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation, updated_at)
         VALUES ('host-a', ?, ?, 1, 10)`
      )
      policy.run('repo-1', '{}')
      expect(() => policy.run('repo-1', '{"enabled":true}')).toThrow(
        /UNIQUE|PRIMARY KEY constraint/
      )
      policy.run('repo-2', '{}')
      expect(() =>
        db
          .prepare(
            `INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation, updated_at)
             VALUES ('host-a', 'repo-3', NULL, 1, 10)`
          )
          .run()
      ).toThrow(/NOT NULL constraint failed/)

      const link = db.prepare(
        `INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
         VALUES ('host-a', ?, ?, 10)`
      )
      link.run('repo-1', 'binding-1')
      expect(() => link.run('repo-1', 'binding-2')).toThrow(/UNIQUE|PRIMARY KEY constraint/)
      expect(() => link.run('repo-2', 'binding-1')).toThrow(
        /UNIQUE constraint failed: project_event_repo_links.binding_id/
      )
      link.run('repo-2', 'binding-2')
    } finally {
      db.close()
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

  it('refuses a version-4 file that still has the version-3 delivery table', () => {
    createV3()
    const raw = new Database(dbPath)
    raw.pragma('user_version = 4')
    raw.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxCorruptError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(4)
  })

  it('gives every delivery row exactly one subject and lets a parked row keep its body', () => {
    const { db } = openForgeInboxDatabase(dbPath)
    try {
      const insert = (
        instanceId: string | null,
        bindingId: string | null,
        state = 'pending',
        body = "X'01'"
      ) =>
        db
          .prepare(
            `INSERT INTO webhook_deliveries (host_id, instance_id, binding_id, project_id, dedupe_key,
              event_kind, admitted_at, state, body)
             VALUES ('host-a', ?, ?, 'group/repo', 'dedupe-1', 'merge_request.updated', 10, ?,
               ${body})`
          )
          .run(instanceId, bindingId, state)

      expect(() => insert('gitlab-main', 'binding-1')).toThrow(/CHECK constraint failed/)
      expect(() => insert(null, null)).toThrow(/CHECK constraint failed/)
      expect(() => insert(null, 'binding-1', 'skipped')).toThrow(/CHECK constraint failed/)

      insert(null, 'binding-1', 'parked')
      expect(
        db
          .prepare(
            "SELECT binding_id, body, parked_reason FROM webhook_deliveries WHERE state = 'parked'"
          )
          .get()
      ).toEqual({ binding_id: 'binding-1', body: new Uint8Array([1]), parked_reason: null })
      // Deduplication follows the subject: a binding row does not collide with an instance row.
      insert('gitlab-main', null)
      expect(
        Number(db.prepare('SELECT count(*) AS count FROM webhook_deliveries').get()?.count)
      ).toBe(2)
    } finally {
      db.close()
    }
  })

  it('refuses a version-3 file without project_bindings before touching it', () => {
    createV2()
    const raw = new Database(dbPath)
    raw.pragma('user_version = 3')
    raw.close()
    const before = digest()

    expect(() => openForgeInboxDatabase(dbPath, 'host-a')).toThrow(ForgeInboxCorruptError)

    expect(digest()).toBe(before)
    expect(rawState(dbPath).version).toBe(3)
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
    expect(Number(migrated.db.pragma('user_version', { simple: true }))).toBe(
      FORGE_INBOX_SCHEMA_VERSION
    )
    expect(migrated.snapshot).toEqual(seeded)
    migrated.db.close()
  })
})
