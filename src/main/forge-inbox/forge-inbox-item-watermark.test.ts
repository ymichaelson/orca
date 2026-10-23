import Database from '../sqlite/sync-database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const KEY = { instanceId: 'gitlab-main', projectId: '42', kind: 'merge_request' as const, iid: 7 }

describe('forge inbox item watermark', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  const ingest = (token: string, sourceOrder: number, dedupeKey: string) =>
    ledger.ingestEvent({
      hostId: ledger.hostId,
      ...KEY,
      dedupeKey,
      eventKind: 'merge_request.updated',
      payload: {},
      versionToken: token,
      sourceOrder,
      title: 'Add thing',
      itemState: 'opened'
    })

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
  })

  afterEach(() => harness.dispose())

  it('is null for an item the ledger has never seen', () => {
    expect(ledger.readItemWatermark(KEY)).toBeNull()
  })

  it('reports the head order and current revision token, and follows advances only', () => {
    ingest('sha256:a', 10, 'd1')
    expect(ledger.readItemWatermark(KEY)).toEqual({ headOrder: 10, versionToken: 'sha256:a' })
    ingest('sha256:b', 20, 'd2')
    ingest('sha256:stale', 5, 'd3')
    expect(ledger.readItemWatermark(KEY)).toEqual({ headOrder: 20, versionToken: 'sha256:b' })
  })

  it('is scoped to the instance and project', () => {
    ingest('sha256:a', 10, 'd1')
    expect(ledger.readItemWatermark({ ...KEY, projectId: '43' })).toBeNull()
    expect(ledger.readItemWatermark({ ...KEY, instanceId: 'gitlab-other' })).toBeNull()
  })

  it('does not read another host item that shares the same key', () => {
    ledger.close()
    const db = new Database(harness.dbPath)
    try {
      db.prepare(
        `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title, state,
           current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES ('host-b', ?, ?, ?, ?, 't', 'opened', 0, 99, 0, 1, 1)`
      ).run(KEY.instanceId, KEY.projectId, KEY.kind, KEY.iid)
    } finally {
      db.close()
    }
    ledger = harness.open()
    expect(ledger.readItemWatermark(KEY)).toBeNull()
  })
})
