import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError } from './forge-inbox-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const PROJECT = { instanceId: INSTANCE_ID, projectId: PROJECT_ID }

describe('forge inbox durable project invalidation', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let revision: number
  const admit = (key: string) =>
    ledger.admitWebhookDelivery({
      ...PROJECT,
      expectedConfigRevision: revision,
      eventKind: 'Note Hook',
      dedupeKey: key,
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{}')
    })
  const generation = () => ledger.readProjectInvalidationGeneration(PROJECT)

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    revision = harness.configure(ledger)
  })
  afterEach(() => harness.dispose())

  it('advances only for new admission and survives pruning every delivery and reopening', () => {
    expect(generation()).toBe(0)
    const first = admit('first')
    if (!first.ok) {
      throw new Error('admission rejected')
    }
    expect(generation()).toBe(1)
    expect(admit('first')).toMatchObject({ ok: true, duplicate: true })
    expect(generation()).toBe(1)
    ledger.markWebhookDeliveryDone(first.deliveryId)
    expect(
      ledger.pruneFinishedWebhookDeliveries({ nowMs: ledger.nowMs(), olderThanMs: 0, limit: 10 })
    ).toBe(1)
    ledger.close()
    ledger = harness.open()
    expect(generation()).toBe(1)
    expect(admit('second')).toMatchObject({ ok: true, duplicate: false })
    expect(generation()).toBe(2)
    expect(ledger.readProjectInvalidationGeneration({ ...PROJECT, projectId: '43' })).toBe(0)
    expect(ledger.readProjectInvalidationGeneration({ ...PROJECT, instanceId: 'other' })).toBe(0)
  })

  it('rolls back the generation with a failed raw delivery insert', () => {
    expect(admit('first')).toMatchObject({ ok: true })
    const db = new Database(harness.dbPath)
    try {
      db.exec(`CREATE TRIGGER reject_delivery BEFORE INSERT ON webhook_deliveries
        BEGIN SELECT RAISE(ABORT, 'insert blocked'); END`)
      expect(() => admit('blocked')).toThrow('insert blocked')
      expect(generation()).toBe(1)
      expect(ledger.listWebhookDeliveries({ limit: 10 })).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('rolls back raw admission if persisting its invalidation generation fails', () => {
    const db = new Database(harness.dbPath)
    try {
      db.exec(`CREATE TRIGGER reject_invalidation BEFORE INSERT ON project_invalidations
        BEGIN SELECT RAISE(ABORT, 'invalidation blocked'); END`)
      expect(() => admit('blocked')).toThrow('invalidation blocked')
      expect(generation()).toBe(0)
      expect(ledger.listWebhookDeliveries({ limit: 10 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('never reuses an exhausted generation and leaves the raw queue unchanged', () => {
    const db = new Database(harness.dbPath)
    try {
      db.prepare(`INSERT INTO project_invalidations (host_id, instance_id, project_id, generation)
        VALUES (?, ?, ?, ?)`).run(ledger.hostId, INSTANCE_ID, PROJECT_ID, Number.MAX_SAFE_INTEGER)
      expect(() => admit('overflow')).toThrow('generation exhausted')
      expect(generation()).toBe(Number.MAX_SAFE_INTEGER)
      expect(ledger.listWebhookDeliveries({ limit: 10 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps another host generation outside this owner observation fence', () => {
    const db = new Database(harness.dbPath)
    try {
      db.prepare(`INSERT INTO project_invalidations (host_id, instance_id, project_id, generation)
        VALUES ('another-host', ?, ?, 99)`).run(INSTANCE_ID, PROJECT_ID)
      expect(generation()).toBe(0)
      expect(admit('own-host')).toMatchObject({ ok: true })
      expect(generation()).toBe(1)
      expect(
        db
          .prepare("SELECT generation FROM project_invalidations WHERE host_id = 'another-host'")
          .get()
      ).toMatchObject({ generation: 99 })
    } finally {
      db.close()
    }
  })

  it('does not advance when capacity or admission config validation rejects the delivery', () => {
    ledger.close()
    ledger = harness.open({ webhookQueueLimits: { maxPending: 1, maxQueuedBytes: 1024 } })
    expect(admit('first')).toMatchObject({ ok: true })
    expect(admit('full')).toEqual({ ok: false, reason: 'queue-full' })
    expect(generation()).toBe(1)
    const changed = ledger.updateConfig(revision, ledger.getConfig().config)
    expect(changed).toMatchObject({ ok: true })
    expect(admit('stale')).toEqual({ ok: false, reason: 'stale-config' })
    expect(generation()).toBe(1)
  })

  it('requires the captured generation at the trusted observation transaction', () => {
    const captured = generation()
    expect(admit('new-invalidation')).toMatchObject({ ok: true })
    expect(
      ledger.ingestObservation(
        {
          hostId: ledger.hostId,
          ...PROJECT,
          kind: 'merge_request',
          iid: 7,
          dedupeKey: 'observed',
          eventKind: 'observed',
          payload: null,
          versionToken: 'context',
          queueRun: { reason: 'review-request' }
        },
        revision,
        captured
      )
    ).toEqual({ ok: false, reason: 'dirty-observation' })
    expect(ledger.listItems({ instanceId: INSTANCE_ID, clientId: 'test', limit: 10 }).rows).toEqual(
      []
    )
  })

  it('refuses a malformed pre-release invalidation table before writing persistent pragmas', () => {
    ledger.close()
    const db = new Database(harness.dbPath)
    db.exec('ALTER TABLE project_invalidations DROP COLUMN generation')
    db.close()
    const before = readFileSync(harness.dbPath)

    expect(() => harness.open()).toThrow(ForgeInboxCorruptError)

    expect(readFileSync(harness.dbPath)).toEqual(before)
  })
})
