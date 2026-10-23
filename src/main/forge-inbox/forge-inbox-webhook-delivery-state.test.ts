import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxCorruptError } from './forge-inbox-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  FORGE_WEBHOOK_CLAIM_SQL,
  FORGE_WEBHOOK_SCHEDULE_SQL,
  FORGE_WEBHOOK_PRUNE_SQL,
  forgeWebhookRetryDelayMs
} from './forge-inbox-webhook-delivery-state'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HORIZON = 7 * 24 * 60 * MINUTE
const NOTE_TEXT = 'private-merge-request-text'

describe('forge inbox webhook delivery state machine', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let revision: number

  const admit = (key: string, body = `{"note":"${NOTE_TEXT}"}`) => {
    const result = ledger.admitWebhookDelivery({
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      expectedConfigRevision: revision,
      eventKind: 'Note Hook',
      dedupeKey: key,
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from(body)
    })
    if (!result.ok) {
      throw new Error(`admit failed: ${result.reason}`)
    }
    return result
  }

  // Closing and reopening the ledger is also how a worker crash/restart is simulated.
  const withRawDb = <T>(run: (db: Database.Database) => T): T => {
    ledger.close()
    const db = new Database(harness.dbPath)
    try {
      return run(db)
    } finally {
      db.close()
      ledger = harness.open()
    }
  }

  const restart = () => withRawDb(() => undefined)

  const rows = () =>
    withRawDb((db) =>
      db
        .prepare(
          `SELECT id, host_id, state, attempts, next_attempt_at, last_error_code, finished_at,
             LENGTH(body) AS bytes FROM webhook_deliveries ORDER BY id`
        )
        .all()
    )

  const claimId = (nowMs: number) => ledger.claimNextWebhookDelivery(nowMs)?.id ?? null

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    revision = harness.configure(ledger)
  })

  afterEach(() => harness.dispose())

  it('claims the oldest pending delivery and only finished rows leave the queue', () => {
    const first = admit('k1')
    const second = admit('k2')
    expect(claimId(0)).toBe(first.deliveryId)
    expect(ledger.markWebhookDeliveryDone(first.deliveryId)).toEqual({ ok: true })
    expect(claimId(0)).toBe(second.deliveryId)
    ledger.markWebhookDeliveryDone(second.deliveryId)
    expect(ledger.claimNextWebhookDelivery(0)).toBeNull()
  })

  it('does not re-offer a claimed delivery immediately; it waits out the backoff', () => {
    const { deliveryId } = admit('k1')
    expect(claimId(0)).toBe(deliveryId)
    expect(claimId(0)).toBeNull()
    expect(claimId(30 * SECOND - 1)).toBeNull()
    expect(claimId(30 * SECOND)).toBe(deliveryId)
    expect(rows()).toMatchObject([{ attempts: 2, next_attempt_at: 30 * SECOND + 60 * SECOND }])
  })

  it('stops a poison body that crashes the worker on every claim', () => {
    const { deliveryId } = admit('poison')
    let now = 0
    const offered: (number | null)[] = []
    for (let crash = 0; crash < 5; crash++) {
      offered.push(claimId(now))
      restart()
      now += 15 * MINUTE
    }
    expect(offered).toEqual([deliveryId, deliveryId, deliveryId, deliveryId, deliveryId])
    expect(claimId(now)).toBeNull()
    expect(rows()).toMatchObject([
      { state: 'failed', attempts: 5, last_error_code: 'crash-loop', bytes: 0 }
    ])
  })

  it('skips an exhausted poison row and serves the next eligible one in the same claim', () => {
    const poison = admit('poison')
    let now = 0
    for (let crash = 0; crash < 5; crash++) {
      claimId(now)
      now += 15 * MINUTE
    }
    const next = admit('next')
    expect(claimId(now)).toBe(next.deliveryId)
    expect(rows()).toMatchObject([
      { id: poison.deliveryId, state: 'failed', last_error_code: 'crash-loop' },
      { id: next.deliveryId, state: 'pending', attempts: 1 }
    ])
  })

  it('skips a row waiting for retry in favour of a later ready one', () => {
    const first = admit('k1')
    const second = admit('k2')
    expect(claimId(0)).toBe(first.deliveryId)
    ledger.markWebhookDeliveryFailed(first.deliveryId, { code: 'api-unavailable', nowMs: 0 })
    expect(claimId(0)).toBe(second.deliveryId)
    expect(claimId(30 * SECOND)).toBe(first.deliveryId)
  })

  it('retries with 30s doubling backoff and goes terminal on the fifth failure', () => {
    const { deliveryId } = admit('k1')
    const delays: number[] = []
    let now = 10_000
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(claimId(now)).toBe(deliveryId)
      const outcome = ledger.markWebhookDeliveryFailed(deliveryId, {
        code: 'api-unavailable',
        nowMs: now
      })
      if (attempt < 5) {
        if (!outcome.ok || outcome.state !== 'pending') {
          throw new Error('expected a retry')
        }
        delays.push(outcome.retryAtMs - now)
        expect(claimId(outcome.retryAtMs - 1)).toBeNull()
        now = outcome.retryAtMs
      } else {
        expect(outcome).toEqual({ ok: true, state: 'failed' })
      }
    }
    expect(delays).toEqual([30 * SECOND, 60 * SECOND, 120 * SECOND, 240 * SECOND])
    expect(rows()).toMatchObject([
      { state: 'failed', attempts: 5, last_error_code: 'api-unavailable' }
    ])
    expect(claimId(now + 24 * 60 * MINUTE)).toBeNull()
  })

  it('caps a single backoff at 15 minutes', () => {
    expect(forgeWebhookRetryDelayMs(1)).toBe(30 * SECOND)
    expect(forgeWebhookRetryDelayMs(8)).toBe(15 * MINUTE)
  })

  it('keeps no payload text in any column once a delivery finishes', () => {
    const done = admit('done')
    const failed = admit('failed')
    const pending = admit('pending')
    const dump = () =>
      withRawDb((db) =>
        db
          .prepare('SELECT * FROM webhook_deliveries ORDER BY id')
          .all()
          .map((row) =>
            Object.values(row)
              .map((value) =>
                value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : String(value)
              )
              .join('|')
          )
      )
    expect(dump().every((row) => row.includes(NOTE_TEXT))).toBe(true)

    ledger.markWebhookDeliveryDone(done.deliveryId)
    ledger.markWebhookDeliveryFailed(failed.deliveryId, {
      code: 'malformed-payload',
      terminal: true
    })
    const after = dump()
    expect(after[0]).not.toContain(NOTE_TEXT)
    expect(after[1]).not.toContain(NOTE_TEXT)
    expect(after[2]).toContain(NOTE_TEXT)
    expect(pending.duplicate).toBe(false)
  })

  it.each([
    ['payload text', `bad body: ${NOTE_TEXT}`],
    ['an exception message', 'Error: connect ECONNREFUSED 10.0.0.1:443'],
    ['an empty code', ''],
    ['an over-long code', 'a'.repeat(65)],
    ['upper-case', 'Api-Unavailable']
  ])('refuses %s as a stored error code and leaves the row untouched', (_name, code) => {
    const { deliveryId } = admit('k1')
    claimId(0)
    expect(() => ledger.markWebhookDeliveryFailed(deliveryId, { code, terminal: true })).toThrow(
      /error code/
    )
    expect(() => ledger.markWebhookDeliveryFailed(deliveryId, { code, nowMs: 0 })).toThrow(
      /error code/
    )
    expect(rows()).toMatchObject([{ state: 'pending', last_error_code: null }])
  })

  it('clears the body of a done delivery and stamps its completion time', () => {
    const { deliveryId } = admit('k1')
    ledger.markWebhookDeliveryDone(deliveryId)
    const [row] = rows()
    expect(row).toMatchObject({ state: 'done', bytes: 0 })
    expect(row.finished_at).toEqual(expect.any(Number))
  })

  describe('transitions are guarded by state', () => {
    it('refuses late or out-of-order marks without mutating the row', () => {
      const failed = admit('failed')
      const done = admit('done')
      ledger.markWebhookDeliveryFailed(failed.deliveryId, { code: 'x-code', terminal: true })
      ledger.markWebhookDeliveryDone(done.deliveryId)
      const before = rows()
      const invalid = { ok: false, reason: 'invalid-state' }

      expect(ledger.markWebhookDeliveryDone(failed.deliveryId)).toEqual(invalid)
      expect(ledger.markWebhookDeliveryNeedsAuth(done.deliveryId)).toEqual(invalid)
      expect(ledger.markWebhookDeliveryNeedsAuth(failed.deliveryId)).toEqual(invalid)
      expect(
        ledger.markWebhookDeliveryFailed(done.deliveryId, { code: 'y-code', terminal: true })
      ).toEqual(invalid)
      expect(
        ledger.markWebhookDeliveryFailed(failed.deliveryId, { code: 'y-code', nowMs: 0 })
      ).toEqual(invalid)
      expect(rows()).toEqual(before)
    })

    it('refuses failing a needs-auth delivery, but lets it complete', () => {
      const { deliveryId } = admit('k1')
      ledger.markWebhookDeliveryNeedsAuth(deliveryId)
      expect(
        ledger.markWebhookDeliveryFailed(deliveryId, { code: 'x-code', terminal: true })
      ).toEqual({ ok: false, reason: 'invalid-state' })
      expect(ledger.markWebhookDeliveryDone(deliveryId)).toEqual({ ok: true })
    })

    it('reports an unknown delivery as not found', () => {
      expect(ledger.markWebhookDeliveryDone(999)).toEqual({ ok: false, reason: 'not-found' })
      expect(ledger.markWebhookDeliveryNeedsAuth(999)).toEqual({ ok: false, reason: 'not-found' })
      expect(ledger.markWebhookDeliveryFailed(999, { code: 'x-code', terminal: true })).toEqual({
        ok: false,
        reason: 'not-found'
      })
    })
  })

  it('parks needs-auth deliveries until a credential for that instance is written', () => {
    revision = harness.configure(
      ledger,
      webhookConfig([
        webhookInstance(),
        webhookInstance({
          id: 'gitlab-other',
          displayName: 'Other',
          baseUrl: 'https://other.example.com'
        })
      ])
    )
    const mine = admit('k1')
    expect(claimId(0)).toBe(mine.deliveryId)
    ledger.markWebhookDeliveryNeedsAuth(mine.deliveryId)
    expect(claimId(60 * SECOND)).toBeNull()

    expect(ledger.requeueNeedsAuthWebhookDeliveries('gitlab-other')).toBe(0)
    expect(claimId(60 * SECOND)).toBeNull()
    const before = ledger.getWebhookQueueStatus()
    expect(ledger.requeueNeedsAuthWebhookDeliveries(INSTANCE_ID)).toBe(1)
    expect(ledger.getWebhookQueueStatus()).toEqual(before)
    expect(rows()).toMatchObject([{ state: 'pending', attempts: 0, next_attempt_at: null }])
    expect(claimId(0)).toBe(mine.deliveryId)
  })

  it('does not requeue done or failed rows', () => {
    const done = admit('done')
    const failed = admit('failed')
    ledger.markWebhookDeliveryDone(done.deliveryId)
    ledger.markWebhookDeliveryFailed(failed.deliveryId, { code: 'x-code', terminal: true })
    expect(ledger.requeueNeedsAuthWebhookDeliveries(INSTANCE_ID)).toBe(0)
    expect(rows()).toMatchObject([{ state: 'done' }, { state: 'failed' }])
  })

  it('keeps every state, attempt count and retry time across a restart', () => {
    const retry = admit('retry')
    const parked = admit('parked')
    const finished = admit('finished')
    ledger.claimNextWebhookDelivery(5_000)
    ledger.markWebhookDeliveryFailed(retry.deliveryId, { code: 'api-unavailable', nowMs: 5_000 })
    ledger.markWebhookDeliveryNeedsAuth(parked.deliveryId)
    ledger.markWebhookDeliveryDone(finished.deliveryId)
    restart()

    expect(rows()).toMatchObject([
      { state: 'pending', attempts: 1, next_attempt_at: 5_000 + 30 * SECOND },
      { state: 'needs-auth' },
      { state: 'done' }
    ])
    expect(claimId(5_000)).toBeNull()
    expect(claimId(5_000 + 30 * SECOND)).toBe(retry.deliveryId)
  })

  it('counts needs-auth bodies against queue capacity but not done ones', () => {
    ledger.close()
    ledger = harness.open({ webhookQueueLimits: { maxPending: 2, maxQueuedBytes: 1024 } })
    const a = admit('a')
    const b = admit('b')
    ledger.markWebhookDeliveryNeedsAuth(a.deliveryId)
    expect(ledger.getWebhookQueueStatus()).toMatchObject({ pending: 2 })
    expect(() => admit('c')).toThrow(/queue-full/)

    ledger.markWebhookDeliveryDone(b.deliveryId)
    expect(ledger.getWebhookQueueStatus()).toMatchObject({
      pending: 1,
      queuedBytes: Buffer.byteLength(`{"note":"${NOTE_TEXT}"}`)
    })
    expect(admit('c').duplicate).toBe(false)
  })

  it('lists only pending rows, not needs-auth or done ones', () => {
    const a = admit('a')
    const b = admit('b')
    const c = admit('c')
    ledger.markWebhookDeliveryDone(a.deliveryId)
    ledger.markWebhookDeliveryNeedsAuth(b.deliveryId)
    expect(ledger.listWebhookDeliveries({ limit: 10 }).map((row) => row.id)).toEqual([c.deliveryId])
  })

  describe('pruning', () => {
    const prune = (nowMs: number, limit = 10) =>
      ledger.pruneFinishedWebhookDeliveries({ nowMs, olderThanMs: HORIZON, limit })

    it('keeps the dedupe key until the horizon so a late redelivery stays a duplicate', () => {
      const { deliveryId } = admit('k1')
      ledger.markWebhookDeliveryDone(deliveryId)
      expect(prune(10_000)).toBe(0)
      expect(admit('k1')).toMatchObject({ duplicate: true, deliveryId })
    })

    it('runs the horizon from completion, not admission', () => {
      const { deliveryId } = admit('k1')
      withRawDb((db) => db.prepare('UPDATE webhook_deliveries SET admitted_at = 0').run())
      ledger.markWebhookDeliveryDone(deliveryId)
      const [row] = rows()
      const finishedAt = Number(row.finished_at)

      expect(prune(HORIZON + 10)).toBe(0)
      expect(admit('k1')).toMatchObject({ duplicate: true, deliveryId })
      expect(prune(finishedAt + HORIZON)).toBe(1)
    })

    it('never prunes a finished row that has no completion time', () => {
      const { deliveryId } = admit('k1')
      ledger.markWebhookDeliveryDone(deliveryId)
      withRawDb((db) => db.prepare('UPDATE webhook_deliveries SET finished_at = NULL').run())
      expect(prune(Number.MAX_SAFE_INTEGER)).toBe(0)
    })

    it('deletes only done and failed rows past the horizon, up to the limit', () => {
      const done = admit('done')
      const failed = admit('failed')
      const parked = admit('parked')
      admit('pending')
      claimId(0)
      ledger.markWebhookDeliveryDone(done.deliveryId)
      ledger.markWebhookDeliveryFailed(failed.deliveryId, { code: 'x-code', terminal: true })
      ledger.markWebhookDeliveryNeedsAuth(parked.deliveryId)
      const late = Date.now() + HORIZON

      expect(prune(late, 1)).toBe(1)
      expect(prune(late)).toBe(1)
      expect(rows().map((row) => row.state)).toEqual(['needs-auth', 'pending'])
    })

    it('never prunes unfinished rows even if they carry a stale completion time', () => {
      const pending = admit('pending')
      const parked = admit('parked')
      ledger.markWebhookDeliveryNeedsAuth(parked.deliveryId)
      withRawDb((db) => db.prepare('UPDATE webhook_deliveries SET finished_at = 0').run())
      expect(prune(Number.MAX_SAFE_INTEGER)).toBe(0)
      expect(rows().map((row) => row.id)).toEqual([pending.deliveryId, parked.deliveryId])
    })

    it('treats a redelivery after the horizon as new work', () => {
      const first = admit('k1')
      ledger.markWebhookDeliveryDone(first.deliveryId)
      prune(Date.now() + HORIZON)
      expect(admit('k1').duplicate).toBe(false)
      expect(ledger.listWebhookDeliveries({ limit: 10 })).toHaveLength(1)
    })
  })

  describe('host isolation in a shared file', () => {
    // A file is owned by one host, so another host's rows can only be planted directly.
    const plant = (
      state: string,
      options: {
        instanceId?: string
        finishedAt?: number | null
        attempts?: number
        dedupeKey?: string
      } = {}
    ) =>
      withRawDb((db) => {
        const result = db
          .prepare(
            `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key,
               event_kind, config_revision, admitted_at, state, attempts, finished_at, body)
             VALUES ('host-b', ?, ?, ?, 'Note Hook', 1, 1, ?, ?, ?, x'7b7d')`
          )
          .run(
            options.instanceId ?? INSTANCE_ID,
            PROJECT_ID,
            options.dedupeKey ?? `foreign-${state}`,
            state,
            options.attempts ?? 0,
            options.finishedAt === undefined ? 0 : options.finishedAt
          )
        return Number(result.lastInsertRowid)
      })

    it('never claims, requeues, prunes, counts or marks another host rows', () => {
      const pendingId = plant('pending', { finishedAt: null })
      const parkedId = plant('needs-auth', { finishedAt: null })
      const doneId = plant('done')
      const own = admit('own')

      expect(claimId(0)).toBe(own.deliveryId)
      expect(ledger.requeueNeedsAuthWebhookDeliveries(INSTANCE_ID)).toBe(0)
      expect(
        ledger.pruneFinishedWebhookDeliveries({ nowMs: 1e12, olderThanMs: 1, limit: 10 })
      ).toBe(0)
      expect(ledger.getWebhookQueueStatus()).toMatchObject({ pending: 1 })
      for (const id of [pendingId, parkedId, doneId]) {
        expect(ledger.markWebhookDeliveryDone(id)).toEqual({ ok: false, reason: 'not-found' })
        expect(ledger.markWebhookDeliveryNeedsAuth(id)).toEqual({ ok: false, reason: 'not-found' })
        expect(ledger.markWebhookDeliveryFailed(id, { code: 'x-code', terminal: true })).toEqual({
          ok: false,
          reason: 'not-found'
        })
      }
      ledger.markWebhookDeliveryDone(own.deliveryId)
      expect(claimId(1e12)).toBeNull()
      expect(rows().filter((row) => row.host_id === 'host-b')).toMatchObject([
        { state: 'pending', attempts: 0 },
        { state: 'needs-auth' },
        { state: 'done' }
      ])
    })

    it('admits an own delivery whose dedupe key another host already holds', () => {
      plant('pending', { dedupeKey: 'shared-key', finishedAt: null })
      const own = admit('shared-key')
      expect(own.duplicate).toBe(false)
      expect(ledger.listWebhookDeliveries({ limit: 10 }).map((row) => row.id)).toEqual([
        own.deliveryId
      ])
      expect(admit('shared-key')).toMatchObject({ duplicate: true, deliveryId: own.deliveryId })
    })

    it('leaves a foreign row at the attempt bound for its own host to fail', () => {
      const foreign = plant('pending', { attempts: 5, finishedAt: null })
      expect(claimId(0)).toBeNull()
      expect(rows().find((row) => row.id === foreign)).toMatchObject({
        state: 'pending',
        attempts: 5,
        last_error_code: null
      })
    })
  })

  describe('input validation', () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -Infinity])(
      'refuses nowMs %s everywhere it is used, before any write',
      (nowMs) => {
        const { deliveryId } = admit('k1')
        const before = rows()
        expect(() => ledger.claimNextWebhookDelivery(nowMs)).toThrow(/nowMs/)
        expect(() =>
          ledger.markWebhookDeliveryFailed(deliveryId, { code: 'x-code', nowMs })
        ).toThrow(/nowMs/)
        expect(() =>
          ledger.pruneFinishedWebhookDeliveries({ nowMs, olderThanMs: 1, limit: 1 })
        ).toThrow(/nowMs/)
        expect(rows()).toEqual(before)
      }
    )

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
      'never lets prune limit %s delete more than nothing',
      (limit) => {
        const { deliveryId } = admit('k1')
        ledger.markWebhookDeliveryDone(deliveryId)
        expect(ledger.pruneFinishedWebhookDeliveries({ nowMs: 1e12, olderThanMs: 1, limit })).toBe(
          0
        )
        expect(rows()).toHaveLength(1)
      }
    )
  })

  describe('indexes', () => {
    const plan = (sql: string, params: (string | number)[]) =>
      withRawDb((db) =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => String(row.detail))
      )

    it('serves the work schedule query from an index search', () => {
      const detail = plan(FORGE_WEBHOOK_SCHEDULE_SQL, ['host-a']).join('\n')
      expect(detail).toMatch(
        /SEARCH webhook_deliveries USING (COVERING )?INDEX webhook_deliveries_claim/
      )
      expect(detail).not.toMatch(/SCAN webhook_deliveries/)
    })

    it('serves the claim query from an index search', () => {
      const detail = plan(FORGE_WEBHOOK_CLAIM_SQL, ['host-a', 0]).join('\n')
      expect(detail).toMatch(
        /SEARCH webhook_deliveries USING (COVERING )?INDEX webhook_deliveries_claim \(host_id=\? AND state=\?/
      )
      expect(detail).not.toMatch(/SCAN webhook_deliveries/)
    })

    it('serves the prune query from the finished-row index', () => {
      const detail = plan(FORGE_WEBHOOK_PRUNE_SQL, ['host-a', 0, 10]).join('\n')
      expect(detail).toMatch(/USING (COVERING )?INDEX webhook_deliveries_finished/)
      expect(detail).not.toMatch(/SCAN webhook_deliveries/)
    })

    it('refuses a file that lacks the claim or prune index', () => {
      for (const index of ['webhook_deliveries_claim', 'webhook_deliveries_finished']) {
        const fresh = createWebhookHarness()
        try {
          fresh.open().close()
          const db = new Database(fresh.dbPath)
          try {
            db.exec(`DROP INDEX ${index}`)
          } finally {
            db.close()
          }
          expect(() => fresh.open()).toThrow(ForgeInboxCorruptError)
        } finally {
          fresh.dispose()
        }
      }
    })
  })

  it('refuses a file whose webhook_deliveries table predates the retry columns', () => {
    ledger.close()
    const db = new Database(harness.dbPath)
    try {
      db.exec('ALTER TABLE webhook_deliveries DROP COLUMN last_error_code')
    } finally {
      db.close()
    }
    expect(() => harness.open()).toThrow(ForgeInboxCorruptError)
  })

  it('rejects a state outside the schema at the database level', () => {
    admit('k1')
    withRawDb((db) => {
      expect(() => db.prepare("UPDATE webhook_deliveries SET state = 'bogus'").run()).toThrow(
        /CHECK/
      )
      db.prepare("UPDATE webhook_deliveries SET state = 'needs-auth'").run()
    })
  })
})
