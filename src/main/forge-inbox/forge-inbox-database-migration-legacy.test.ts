import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError, openForgeInboxDatabase } from './forge-inbox-database'
import {
  columnNames,
  createV1 as createV1At,
  createV2 as createV2At,
  createV3 as createV3At,
  expectV8PolicyTriggerAndDeliveryIndex,
  openLedger,
  rawState
} from './forge-inbox-database-migration-upgrade-fixture'
import {
  PROJECT_BINDINGS_COLUMNS,
  PROJECT_EVENT_POLICIES_COLUMNS,
  PROJECT_EVENT_REPO_LINKS_COLUMNS
} from './forge-inbox-database-migration-v1-fixture'
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

  it('migrates a released version-1 ledger to the current schema version preserving every row and credential byte', () => {
    createV1()
    const before = rawState(dbPath)

    const opened = open()
    try {
      expect(opened.hostId).toBe('host-a')
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
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
      expect(columnNames(opened.db, 'project_bindings')).toEqual([...PROJECT_BINDINGS_COLUMNS])
      expect(columnNames(opened.db, 'project_event_policies')).toEqual([
        ...PROJECT_EVENT_POLICIES_COLUMNS
      ])
      expect(columnNames(opened.db, 'project_event_repo_links')).toEqual([
        ...PROJECT_EVENT_REPO_LINKS_COLUMNS
      ])

      const reopened = open()
      reopened.db.close()
      expect(reopened.snapshot).toEqual(before.snapshot)
      expect(reopened.hostId).toBe('host-a')
    } finally {
      opened.db.close()
    }
  })

  it('creates a version-9 ledger with a project_bindings table on first open', () => {
    const opened = openForgeInboxDatabase(dbPath)
    try {
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(columnNames(opened.db, 'patch_requests')).toHaveLength(17)
      expect(columnNames(opened.db, 'project_bindings')).toEqual([...PROJECT_BINDINGS_COLUMNS])
      expect(columnNames(opened.db, 'project_event_policies')).toEqual([
        ...PROJECT_EVENT_POLICIES_COLUMNS
      ])
      expect(columnNames(opened.db, 'project_event_repo_links')).toEqual([
        ...PROJECT_EVENT_REPO_LINKS_COLUMNS
      ])
      expect(
        opened.db.prepare("SELECT type FROM sqlite_master WHERE name = 'patch_requests'").get()
          ?.type
      ).toBe('table')
      expect(
        opened.db
          .prepare("SELECT type FROM sqlite_master WHERE name = 'project_event_wait_wake'")
          .get()?.type
      ).toBe('trigger')
      expectV8PolicyTriggerAndDeliveryIndex(opened.db)

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

  it('migrates a released version-2 ledger to the current schema version preserving every row and credential byte', () => {
    createV2()
    const before = rawState(dbPath)

    const opened = open()
    try {
      expect(opened.hostId).toBe('host-a')
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(opened.snapshot).toEqual(before.snapshot)
      expect(columnNames(opened.db, 'project_bindings')).toEqual([...PROJECT_BINDINGS_COLUMNS])
      expect(columnNames(opened.db, 'project_event_policies')).toEqual([
        ...PROJECT_EVENT_POLICIES_COLUMNS
      ])
      expect(columnNames(opened.db, 'project_event_repo_links')).toEqual([
        ...PROJECT_EVENT_REPO_LINKS_COLUMNS
      ])
    } finally {
      opened.db.close()
    }
  })

  it('migrates a released version-3 ledger to the current schema version preserving every delivery row', () => {
    createV3()
    const before = rawState(dbPath)

    const opened = open()
    try {
      expect(opened.hostId).toBe('host-a')
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(opened.snapshot).toEqual(before.snapshot)
      // The legacy subject survives; the new subject columns stay empty for rows admitted before v4.
      expect(
        opened.db
          .prepare(
            'SELECT instance_id, binding_id, config_revision, policy_generation, parked_reason FROM webhook_deliveries'
          )
          .all()
      ).toEqual([
        {
          instance_id: 'gitlab-main',
          binding_id: null,
          config_revision: 7,
          policy_generation: null,
          parked_reason: null
        }
      ])
    } finally {
      opened.db.close()
    }
  })
})
