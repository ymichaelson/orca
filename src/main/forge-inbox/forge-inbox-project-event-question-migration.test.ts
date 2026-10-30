import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { createForgeInboxV8TablesSql, FORGE_INBOX_SCHEMA_VERSION } from './forge-inbox-schema'
import { createForgeInboxV10TablesSql } from './forge-inbox-schema-project-binding-secret-window'

function questionColumns(db: Database.Database): string[] {
  return db
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('project_event_questions')
    .map((row) => String(row.name))
}

describe('forge inbox v9 question migration', () => {
  let root: string
  let dbPath: string

  function createV8WithAwaitingUser(): void {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV8TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO webhook_deliveries (id, host_id, binding_id, project_id, dedupe_key,
      event_kind, policy_generation, admitted_at, state, decision_state, parked_reason, attempts,
      body)
      VALUES (1, 'host-a', 'binding', 'group/demo', 'delivery-1', 'Merge Request Hook', 1, 1,
        'parked', 'decided', 'awaiting-user', 1, x'01')`)
    raw.exec(`INSERT INTO project_bindings (binding_id, project_path, gitlab_host, gitlab_path,
      gitlab_project_id, callback_url, state, created_at, updated_at)
      VALUES ('binding', '/repo', 'gitlab.test', 'group/demo', 3, 'https://x/y', 'connected', 1, 1)`)
    raw.exec(`INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
      VALUES ('host-a', 'repo-1', 'binding', 1)`)
    raw.exec(`INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation,
      updated_at) VALUES ('host-a', 'repo-1', '{"enabled":true}', 1, 1)`)
    raw.exec(`INSERT INTO project_event_decisions (id, host_id, delivery_id, policy_generation,
      provider, model, action, confidence, input_tokens, output_tokens, decided_at, item_id,
      action_state, last_error_code, action_finished_at)
      VALUES (1, 'host-a', 1, 1, 'jev', 'm', 'ask_user', 0.9, 1, 1, 2, 1, 'blocked', 'awaiting-user', 2)`)
    raw.pragma('user_version = 8')
    raw.close()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-v9-'))
    dbPath = join(root, 'forge-inbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('adds the question table to an existing v8 file without touching its rows', () => {
    createV8WithAwaitingUser()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(questionColumns(opened.db)).toEqual([
        'id',
        'host_id',
        'delivery_id',
        'decision_id',
        'item_id',
        'question',
        'status',
        'answer',
        'asked_at',
        'answered_at',
        'subject_kind',
        'subject_iid',
        'subject_title',
        'source'
      ])
      expect(
        opened.db
          .prepare(
            `SELECT state, parked_reason, decision_state FROM webhook_deliveries WHERE id = 1`
          )
          .get()
      ).toEqual({ state: 'parked', parked_reason: 'awaiting-user', decision_state: 'decided' })
      expect(
        opened.db
          .prepare(
            `SELECT action, action_state, last_error_code FROM project_event_decisions WHERE id = 1`
          )
          .get()
      ).toEqual({ action: 'ask_user', action_state: 'blocked', last_error_code: 'awaiting-user' })
      opened.db
        .prepare(
          `INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id,
           question, status, asked_at) VALUES (?, 1, 1, 1, 'q', 'open', 3)`
        )
        .run('host-a')
      expect(questionColumns(opened.db)).toContain('status')
    } finally {
      opened.db.close()
    }
  })

  it('reopens a migrated file without rerunning anything', () => {
    createV8WithAwaitingUser()
    openForgeInboxDatabase(dbPath, 'host-a').db.close()

    const reopened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(questionColumns(reopened.db)).toHaveLength(14)
      expect(
        reopened.db.prepare('SELECT COUNT(*) AS count FROM project_event_questions').get()
      ).toEqual({ count: 0 })
    } finally {
      reopened.db.close()
    }
  })

  it('refuses a second open question for one delivery and any third status', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      const insertOpen = opened.db.prepare(
        `INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id, question,
         status, asked_at) VALUES (?, 1, ?, 1, 'q', 'open', 3)`
      )
      insertOpen.run('host-a', 1)

      expect(() => insertOpen.run('host-a', 2)).toThrow()
      expect(() =>
        opened.db
          .prepare(
            `INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id,
             question, status, asked_at) VALUES ('host-a', 2, 3, 1, 'q', 'cancelled', 3)`
          )
          .run()
      ).toThrow()
    } finally {
      opened.db.close()
    }
  })

  it('adds the subject columns to v10 questions without touching their rows', () => {
    const raw = new Database(dbPath)
    raw.exec(createForgeInboxV10TablesSql())
    raw.exec("INSERT INTO meta VALUES ('host_id', 'host-a')")
    raw.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
      current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'merge_request', 7, 'Add thing',
        'opened', 1, 1, 1, 1, 1)`)
    raw.exec(`INSERT INTO project_event_questions (id, host_id, delivery_id, decision_id, item_id,
      question, status, asked_at) VALUES (1, 'host-a', 1, 1, 1, 'stored sentence', 'open', 3)`)
    raw.pragma('user_version = 10')
    raw.close()

    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(opened.db.pragma('user_version', { simple: true })).toBe(FORGE_INBOX_SCHEMA_VERSION)
      expect(questionColumns(opened.db)).toEqual([
        'id',
        'host_id',
        'delivery_id',
        'decision_id',
        'item_id',
        'question',
        'status',
        'answer',
        'asked_at',
        'answered_at',
        'subject_kind',
        'subject_iid',
        'subject_title',
        'source'
      ])
      expect(
        opened.db
          .prepare(
            `SELECT question, subject_kind, subject_iid, subject_title
             FROM project_event_questions WHERE id = 1`
          )
          .get()
      ).toEqual({
        question: 'stored sentence',
        subject_kind: null,
        subject_iid: null,
        subject_title: null
      })
    } finally {
      opened.db.close()
    }
  })

  it('creates the question table on a fresh file', () => {
    const opened = openForgeInboxDatabase(dbPath, 'host-a')
    try {
      expect(questionColumns(opened.db)).toHaveLength(14)
    } finally {
      opened.db.close()
    }
  })
})
