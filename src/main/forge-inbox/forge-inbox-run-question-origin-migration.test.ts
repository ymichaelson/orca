import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { createForgeInboxV17TablesSql } from './forge-inbox-schema-item-archive'

describe('forge inbox question origin migration', () => {
  let root: string
  let path: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-question-origin-'))
    path = join(root, 'ledger.sqlite')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('creates the origin column on a fresh ledger with no guessed value', () => {
    const fresh = openForgeInboxDatabase(path, 'host-a')
    expect(fresh.db.pragma('user_version')).toEqual([{ user_version: 19 }])
    const columns = fresh.db.prepare('PRAGMA table_info(runs)').all()
    expect(columns).toContainEqual(
      expect.objectContaining({ name: 'origin_question_id', notnull: 0, dflt_value: null })
    )
    fresh.db.exec(`INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title,
      state, current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'issue', 7, 'Title',
        'opened', 1, 1, 0, 1, 1);
      INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
        context_digest, analysis_kind, reason, created_at, updated_at)
      VALUES (1, 1, 1, 'succeeded', 0, 1, 'head', 'issue', 'review', 1, 1);`)
    expect(fresh.db.prepare('SELECT origin_question_id FROM runs').get()).toEqual({
      origin_question_id: null
    })
    fresh.db.close()
  })

  it('does not backfill an older question into an existing run', () => {
    const old = new Database(path)
    old.exec(createForgeInboxV17TablesSql())
    old.exec(`INSERT INTO meta VALUES ('host_id', 'host-a');
      INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
        current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'issue', 7, 'Title',
        'opened', 1, 1, 0, 1, 1);
      INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id, question,
        status, asked_at)
      VALUES ('host-a', 1, 1, 1, 'Old question', 'open', 1);
      INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
        context_digest, analysis_kind, reason, created_at, updated_at)
      VALUES (1, 1, 1, 'succeeded', 0, 1, 'head', 'issue', 'review', 1, 1);`)
    old.pragma('user_version = 17')
    old.close()

    const migrated = openForgeInboxDatabase(path, 'host-a')
    expect(migrated.db.prepare('SELECT origin_question_id FROM runs').get()).toEqual({
      origin_question_id: null
    })
    migrated.db.close()
  })

  it('upgrades real v17 runs without guessing an answer provenance and reopens them', () => {
    const old = new Database(path)
    old.exec(createForgeInboxV17TablesSql())
    old.exec(`INSERT INTO meta VALUES ('host_id', 'host-a');
      INSERT INTO items (id, host_id, instance_id, project_id, kind, iid, title, state,
        current_revision, head_order, activity_seq, created_at, updated_at)
      VALUES (1, 'host-a', 'gitlab:gitlab.test', 'group/demo', 'issue', 7, 'Title',
        'opened', 1, 1, 0, 1, 1);
      INSERT INTO runs (id, item_id, revision, state, generation, policy_generation,
        context_digest, analysis_kind, reason, created_at, updated_at)
      VALUES (1, 1, 1, 'succeeded', 0, 1, 'head', 'issue', 'review', 1, 1);`)
    old.pragma('user_version = 17')
    old.close()
    const migrated = openForgeInboxDatabase(path, 'host-a')
    expect(
      migrated.db.prepare('SELECT id, context_digest, origin_question_id FROM runs').get()
    ).toEqual({ id: 1, context_digest: 'head', origin_question_id: null })
    expect(migrated.db.pragma('foreign_key_check')).toEqual([])
    migrated.db.close()
    const reopened = openForgeInboxDatabase(path, 'host-a')
    expect(reopened.db.prepare('SELECT origin_question_id FROM runs').get()).toEqual({
      origin_question_id: null
    })
    reopened.db.close()
  })
})
