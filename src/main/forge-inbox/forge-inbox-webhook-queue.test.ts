import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const MIB = 1024 * 1024

describe('forge inbox raw webhook delivery queue', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let revision: number

  const admit = (overrides: Record<string, unknown> = {}) =>
    ledger.admitWebhookDelivery({
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      expectedConfigRevision: revision,
      eventKind: 'Note Hook',
      dedupeKey: 'webhook-id:msg-1',
      correlation: { eventUuid: 'evt-1', configUuid: 'cfg-1' },
      body: Buffer.from('{"object_kind":"note"}'),
      ...overrides
    })

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    revision = harness.configure(ledger)
  })

  afterEach(() => harness.dispose())

  it('stores the exact bytes and admission metadata, and survives reopen', () => {
    const body = Buffer.from('{ "text":  "café \u{1F600}" }\n', 'utf8')
    const admitted = admit({ body })
    expect(admitted).toMatchObject({ ok: true, duplicate: false, configRevision: revision })
    ledger.close()

    ledger = harness.open()
    const [row, ...rest] = ledger.listWebhookDeliveries({ limit: 10 })
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      eventKind: 'Note Hook',
      dedupeKey: 'webhook-id:msg-1',
      eventUuid: 'evt-1',
      configUuid: 'cfg-1',
      configRevision: revision,
      state: 'pending'
    })
    expect(Buffer.compare(row.body, body)).toBe(0)
    expect(ledger.getWebhookQueueStatus()).toMatchObject({
      pending: 1,
      queuedBytes: body.length
    })
  })

  it('creates no items, events or runs for a passive delivery', () => {
    admit()
    ledger.close()
    const db = new Database(harness.dbPath)
    try {
      for (const table of ['items', 'events', 'runs', 'deliveries']) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  it('returns the original admission for a retry, across restart, and keeps distinct messages', () => {
    const first = admit()
    ledger.close()
    ledger = harness.open()

    const retry = admit({ body: Buffer.from('{"object_kind":"note","retry":true}') })
    expect(retry).toMatchObject({ ok: true, duplicate: true })
    expect(retry.ok && first.ok && retry.deliveryId).toBe(first.ok && first.deliveryId)

    // Same config and event UUID, different message identity: must not merge.
    const other = admit({ dedupeKey: 'webhook-id:msg-2' })
    expect(other).toMatchObject({ ok: true, duplicate: false })
    expect(ledger.listWebhookDeliveries({ limit: 10 })).toHaveLength(2)
    // The retry never replaced the original body.
    expect(ledger.listWebhookDeliveries({ limit: 10 })[0].body.toString()).toBe(
      '{"object_kind":"note"}'
    )
  })

  it('scopes the retry identity to the instance', () => {
    const second = webhookInstance({ id: 'gitlab-two', baseUrl: 'https://two.example.com' })
    revision = harness.configure(ledger, webhookConfig([webhookInstance(), second]), {
      secret: 'fake-token-1'
    })
    const a = admit()
    const b = admit({ instanceId: 'gitlab-two', expectedConfigRevision: revision })
    expect(a).toMatchObject({ ok: true, duplicate: false })
    expect(b).toMatchObject({ ok: true, duplicate: false })
  })

  it('refuses stale, unknown and disabled targets without leaving a row', () => {
    expect(admit({ expectedConfigRevision: revision - 1 })).toMatchObject({
      ok: false,
      reason: 'stale-config'
    })
    expect(admit({ instanceId: 'nope' })).toMatchObject({ ok: false, reason: 'unknown-project' })
    expect(admit({ projectId: '999' })).toMatchObject({ ok: false, reason: 'unknown-project' })

    const disabled = webhookInstance({
      projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: false }]
    })
    revision = ledger.getConfig().configRevision
    const updated = ledger.updateConfig(revision, webhookConfig([disabled]))
    if (!updated.ok) {
      throw new Error('config rejected')
    }
    expect(admit({ expectedConfigRevision: updated.configRevision })).toMatchObject({
      ok: false,
      reason: 'project-disabled'
    })
    expect(ledger.getWebhookQueueStatus().pending).toBe(0)
  })

  it('refuses admission once the config moved on after the auth was captured', () => {
    const rotated = ledger.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'webhook',
      secret: 'rotated-token',
      expectedRevision: revision
    })
    expect(rotated.ok).toBe(true)
    expect(admit()).toMatchObject({ ok: false, reason: 'stale-config' })
    expect(ledger.getWebhookQueueStatus().pending).toBe(0)
  })

  it('bounds pending count and queued bytes, and a duplicate never consumes capacity', () => {
    ledger.close()
    ledger = harness.open({ webhookQueueLimits: { maxPending: 2, maxQueuedBytes: 64 } })
    revision = ledger.getConfig().configRevision

    const small = Buffer.alloc(20, 'a')
    const first = admit({ dedupeKey: 'webhook-id:1', body: small })
    admit({ dedupeKey: 'webhook-id:2', body: small })
    expect(admit({ dedupeKey: 'webhook-id:3', body: small })).toMatchObject({
      ok: false,
      reason: 'queue-full'
    })
    const retry = admit({ dedupeKey: 'webhook-id:1', body: small })
    expect(retry).toMatchObject({ ok: true, duplicate: true })
    expect(first.ok && retry.ok && retry.deliveryId === first.deliveryId).toBe(true)
    expect(ledger.getWebhookQueueStatus()).toMatchObject({ pending: 2, queuedBytes: 40 })

    ledger.close()
    ledger = harness.open({ webhookQueueLimits: { maxPending: 10, maxQueuedBytes: 64 } })
    expect(admit({ dedupeKey: 'webhook-id:big', body: Buffer.alloc(30, 'b') })).toMatchObject({
      ok: false,
      reason: 'queue-full'
    })
    expect(ledger.getWebhookQueueStatus().pending).toBe(2)
  })

  it('refuses a body over the per-delivery limit', () => {
    expect(admit({ body: Buffer.alloc(MIB + 1, 'x') })).toMatchObject({
      ok: false,
      reason: 'body-too-large'
    })
    expect(admit({ body: Buffer.alloc(MIB - 1, ' ') })).toMatchObject({ ok: true })
  })

  it('keeps token material out of every stored delivery column', () => {
    admit()
    ledger.close()
    const db = new Database(harness.dbPath)
    try {
      const dump = JSON.stringify(db.prepare('SELECT * FROM webhook_deliveries').all())
      expect(dump).not.toContain('whk-fake-token')
      expect(dump.toLowerCase()).not.toContain('authorization')
    } finally {
      db.close()
    }
  })
})
