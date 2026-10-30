import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import {
  createForgeInboxV4TablesSql,
  createForgeInboxV5TablesSql,
  createForgeInboxV6TablesSql,
  createForgeInboxV7TablesSql,
  FORGE_INBOX_SCHEMA_VERSION
} from './forge-inbox-schema'
import { pruneFinishedForgeWebhookDeliveries } from './forge-inbox-webhook-delivery-state'
import {
  FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
  getForgeWebhookQueueStatus
} from './forge-inbox-webhook-queue'
import {
  expectV8PolicyTriggerAndDeliveryIndex,
  openLedger
} from './forge-inbox-database-migration-upgrade-fixture'

describe('forge inbox ledger schema migration', () => {
  let root: string
  let dbPath: string

  const open = () => openLedger(dbPath)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-schema-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('migrates a released version-4 ledger to the current schema version preserving every delivery row', () => {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV4TablesSql())
    raw.prepare("INSERT INTO meta VALUES ('host_id', 'host-a')").run()
    const created = { db: raw }
    created.db.exec(
      `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
         config_revision, admitted_at, state, body)
       VALUES ('host-a', 'gitlab-main', '42', 'msg:old', 'Merge Request Hook', 7, 1, 'pending', x'01')`
    )
    created.db.pragma('user_version = 4')
    created.db.close()

    const opened = open()
    try {
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(opened.db.prepare('SELECT count(*) AS n FROM webhook_deliveries').get()).toMatchObject(
        { n: 1 }
      )
      expect(
        opened.db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'project_event_decisions'")
          .get()
      ).toBeTruthy()
    } finally {
      opened.db.close()
    }
  })

  it('migrates populated v5 decisions and prunes only unreferenced finished deliveries', () => {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV5TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO webhook_deliveries (id, host_id, binding_id, project_id, dedupe_key,
      event_kind, policy_generation, admitted_at, state, finished_at, body)
      VALUES (1, 'host-a', 'binding', 'group/repo', 'old', 'Issue Hook', 2, 1, 'done', 2, x''),
      (2, 'host-a', 'binding', 'group/repo', 'unrelated', 'Issue Hook', 2, 1, 'done', 2, x'')`)
    raw.exec(`INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
      model, action, confidence, input_tokens, output_tokens, decided_at)
      VALUES ('host-a', 1, 2, 'jev', 'paid-model', 'record_only', 0.9, 42, 7, 2)`)
    raw.pragma('user_version = 5')
    raw.close()
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(
        opened.db
          .prepare(
            'SELECT model, input_tokens, policy_generation, action_state FROM project_event_decisions'
          )
          .get()
      ).toEqual({
        model: 'paid-model',
        input_tokens: 42,
        policy_generation: 2,
        action_state: 'done'
      })
      expect(
        pruneFinishedForgeWebhookDeliveries(
          {
            ...opened,
            now: () => 1000,
            secretStore: () => {
              throw new Error('unused')
            }
          },
          { nowMs: 1000, olderThanMs: 10, limit: 10 }
        )
      ).toBe(1)
      expect(opened.db.prepare('SELECT id, decision_state FROM webhook_deliveries').all()).toEqual([
        { id: 1, decision_state: 'decided' }
      ])
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  it('migrates v6 decisions without replaying work that predates the action pipeline', () => {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV6TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO webhook_deliveries (id, host_id, binding_id, project_id, dedupe_key,
      event_kind, policy_generation, admitted_at, state, body)
      VALUES (1, 'host-a', 'binding', 'group/repo', 'a', 'Issue Hook', 2, 1, 'pending', x'01'),
      (2, 'host-a', 'binding', 'group/repo', 'b', 'Issue Hook', 2, 1, 'pending', x'0102'),
      (3, 'host-a', 'binding', 'group/repo', 'c', 'Issue Hook', 2, 1, 'pending', x'010203')`)
    raw.exec(`INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
      model, action, confidence, input_tokens, output_tokens, decided_at)
      VALUES ('host-a', 1, 2, 'jev', 'm', 'record_only', 0.9, 1, 1, 2),
        ('host-a', 2, 2, 'jev', 'm', 'notify', 0.9, 1, 1, 2),
        ('host-a', 3, 2, 'jev', 'm', 'dispatch_agent', 0.9, 1, 1, 2)`)
    raw.pragma('user_version = 6')
    raw.close()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(
        opened.db
          .prepare(
            'SELECT id, action, action_state, last_error_code FROM project_event_decisions ORDER BY id'
          )
          .all()
      ).toEqual([
        { id: 1, action: 'record_only', action_state: 'done', last_error_code: null },
        {
          id: 2,
          action: 'notify',
          action_state: 'cancelled',
          last_error_code: 'pre-action-upgrade'
        },
        {
          id: 3,
          action: 'dispatch_agent',
          action_state: 'cancelled',
          last_error_code: 'pre-action-upgrade'
        }
      ])
      // A cancelled decision can never settle its delivery, so the migration releases the slot.
      expect(
        opened.db
          .prepare(
            `SELECT id, state, last_error_code, length(body) AS bytes,
             finished_at IS NULL AS unfinished FROM webhook_deliveries ORDER BY id`
          )
          .all()
      ).toEqual([
        { id: 1, state: 'pending', last_error_code: null, bytes: 1, unfinished: 1 },
        { id: 2, state: 'failed', last_error_code: 'pre-action-upgrade', bytes: 0, unfinished: 0 },
        { id: 3, state: 'failed', last_error_code: 'pre-action-upgrade', bytes: 0, unfinished: 0 }
      ])
      expect(opened.db.pragma('foreign_key_check')).toEqual([])
    } finally {
      opened.db.close()
    }
  })

  function seedParkedWait(target: Database.Database, id: number, itemId: number): void {
    target
      .prepare(
        `INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
           current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES (?, 'host-a', 'gitlab:gitlab.test', 'group/repo', 'merge_request', ?, 't',
           'opened', 1, 1, 0, 1, 1)`
      )
      .run(itemId, itemId)
    target
      .prepare(
        `INSERT INTO webhook_deliveries (id, host_id, binding_id, project_id, dedupe_key,
           event_kind, policy_generation, admitted_at, state, parked_reason, decision_state, body)
         VALUES (?, 'host-a', 'binding', 'group/repo', ?, 'Merge Request Hook', 1, 1, 'parked',
           'next-event', 'decided', x'01')`
      )
      .run(id, `delivery-${id}`)
    target
      .prepare(
        `INSERT INTO project_event_decisions (id, host_id, delivery_id, policy_generation,
           provider, model, action, confidence, input_tokens, output_tokens, decided_at, item_id,
           action_state, action_finished_at)
         VALUES (?, 'host-a', ?, 1, 'jev', 'm', 'wait', 0.9, 1, 1, 2, ?, 'awaiting-event', 2)`
      )
      .run(id, id, itemId)
  }

  function createV7WithParkedWaits(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV7TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO project_bindings (binding_id, project_path, gitlab_host, gitlab_path,
      gitlab_project_id, callback_url, state, created_at, updated_at)
      VALUES ('binding', '/repo', 'gitlab.test', 'group/repo', 3, 'https://x/y', 'connected', 1, 1)`)
    raw.exec(`INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
      VALUES ('host-a', 'repo-1', 'binding', 1)`)
    raw.exec(`INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation,
      updated_at) VALUES ('host-a', 'repo-1', '{"enabled":true}', 1, 1)`)
    seedParkedWait(raw, 1, 1)
    seedParkedWait(raw, 2, 2)
    raw.pragma('user_version = 7')
    raw.close()
  }

  function createV7WithQueuedDelivery(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV7TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO project_bindings (binding_id, project_path, gitlab_host, gitlab_path,
      gitlab_project_id, callback_url, state, created_at, updated_at)
      VALUES ('binding', '/repo', 'gitlab.test', 'group/repo', 3, 'https://x/y', 'connected', 1, 1)`)
    raw.exec(`INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
      VALUES ('host-a', 'repo-1', 'binding', 1)`)
    raw.exec(`INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation,
      updated_at) VALUES ('host-a', 'repo-1', '{"enabled":true}', 1, 1)`)
    raw.exec(`INSERT INTO webhook_deliveries (id, host_id, binding_id, project_id, dedupe_key,
      event_kind, policy_generation, admitted_at, state, decision_state, body)
      VALUES (1, 'host-a', 'binding', 'group/repo', 'delivery-1', 'Merge Request Hook', 1, 1,
        'pending', 'queued', x'01')`)
    raw.pragma('user_version = 7')
    raw.close()
  }

  it('finishes a delivery abandoned by a disabled policy edit but keeps an enabled edit queued', () => {
    createV7WithQueuedDelivery()
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    expectV8PolicyTriggerAndDeliveryIndex(opened.db)
    const ctx = {
      db: opened.db,
      hostId: opened.hostId,
      now: () => 10,
      secretStore: () => {
        throw new Error('the migration test never reads a secret')
      }
    }
    const delivery = () =>
      opened.db
        .prepare(
          `SELECT state, decision_state, policy_generation, last_error_code,
           length(body) AS bytes, finished_at IS NULL AS unfinished FROM webhook_deliveries WHERE id = 1`
        )
        .get()
    try {
      opened.db.exec(`UPDATE project_event_policies
        SET policy_json = '{"enabled":true,"rules":"edited"}', generation = 2, updated_at = 2
        WHERE host_id = 'host-a' AND repo_id = 'repo-1'`)
      expect(delivery()).toEqual({
        state: 'pending',
        decision_state: 'queued',
        policy_generation: 2,
        last_error_code: null,
        bytes: 1,
        unfinished: 1
      })

      opened.db.exec(`UPDATE project_event_policies
        SET policy_json = '{"enabled":false}', generation = 3, updated_at = 3
        WHERE host_id = 'host-a' AND repo_id = 'repo-1'`)
      expect(delivery()).toEqual({
        state: 'failed',
        decision_state: 'cancelled',
        policy_generation: 3,
        last_error_code: 'policy-disabled',
        bytes: 0,
        unfinished: 0
      })
      expect(getForgeWebhookQueueStatus(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS).pending).toBe(0)
    } finally {
      opened.db.close()
    }
  })

  it('upgrades a version-7 ledger with a parked wait without waking it', () => {
    createV7WithParkedWaits()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(
        FORGE_INBOX_SCHEMA_VERSION
      )
      expect(
        opened.db
          .prepare(
            'SELECT id, state, decision_state, attempts, parked_reason FROM webhook_deliveries ORDER BY id'
          )
          .all()
      ).toEqual([
        {
          id: 1,
          state: 'parked',
          decision_state: 'decided',
          attempts: 0,
          parked_reason: 'next-event'
        },
        {
          id: 2,
          state: 'parked',
          decision_state: 'decided',
          attempts: 0,
          parked_reason: 'next-event'
        }
      ])
      expect(
        opened.db
          .prepare('SELECT id, action_state, superseded FROM project_event_decisions ORDER BY id')
          .all()
      ).toEqual([
        { id: 1, action_state: 'awaiting-event', superseded: 0 },
        { id: 2, action_state: 'awaiting-event', superseded: 0 }
      ])
    } finally {
      opened.db.close()
    }
  })

  it('wakes only the parked wait of the item a new event lands on', () => {
    createV7WithParkedWaits()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      opened.db.exec(`INSERT INTO events (item_id, revision, event_kind, version_token,
        source_order, payload_json, received_at)
        VALUES (1, 2, 'Merge Request Hook', 'sha256:observed', 1, '{}', 3)`)

      expect(
        opened.db
          .prepare(
            `SELECT id, state, decision_state, decision_token, next_attempt_at, attempts,
             parked_reason, policy_generation FROM webhook_deliveries ORDER BY id`
          )
          .all()
      ).toEqual([
        {
          id: 1,
          state: 'pending',
          decision_state: 'queued',
          decision_token: null,
          next_attempt_at: null,
          attempts: 0,
          parked_reason: null,
          policy_generation: 1
        },
        {
          id: 2,
          state: 'parked',
          decision_state: 'decided',
          decision_token: null,
          next_attempt_at: null,
          attempts: 0,
          parked_reason: 'next-event',
          policy_generation: 1
        }
      ])
      expect(
        opened.db
          .prepare('SELECT id, action_state, superseded FROM project_event_decisions ORDER BY id')
          .all()
      ).toEqual([
        { id: 1, action_state: 'awaiting-event', superseded: 1 },
        { id: 2, action_state: 'awaiting-event', superseded: 0 }
      ])
    } finally {
      opened.db.close()
    }
  })
})
