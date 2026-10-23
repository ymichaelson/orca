import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const MAX_RETRY_AFTER_MS = 300_000

describe('forge inbox direct ledger retry boundaries', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let id: number

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    const revision = harness.configure(ledger)
    const admitted = ledger.admitWebhookDelivery({
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      expectedConfigRevision: revision,
      eventKind: 'Note Hook',
      dedupeKey: 'retry-boundary',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{"note":"retain until terminal"}')
    })
    if (!admitted.ok) {
      throw new Error(`admission rejected: ${admitted.reason}`)
    }
    id = admitted.deliveryId
  })
  afterEach(() => harness.dispose())

  it.each([Number.NaN, Infinity, -Infinity, -1, MAX_RETRY_AFTER_MS + 1, Number.MAX_SAFE_INTEGER])(
    'rejects retryAfterMs %s without changing the existing lease or losing the attempt bound',
    (retryAfterMs) => {
      expect(ledger.claimNextWebhookDelivery(0)?.id).toBe(id)

      expect(() =>
        ledger.markWebhookDeliveryFailed(id, { code: 'api-rate-limited', nowMs: 0, retryAfterMs })
      ).toThrow()

      expect(ledger.claimNextWebhookDelivery(29_999)).toBeNull()
      expect(ledger.claimNextWebhookDelivery(30_000)?.id).toBe(id)
      let now = 30_000
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        const outcome = ledger.markWebhookDeliveryFailed(id, { code: 'api-network', nowMs: now })
        if (attempt === 5) {
          expect(outcome).toEqual({ ok: true, state: 'failed' })
        } else {
          if (!outcome.ok || outcome.state !== 'pending') {
            throw new Error('expected a bounded retry')
          }
          now = outcome.retryAtMs
          expect(ledger.claimNextWebhookDelivery(now)?.id).toBe(id)
        }
      }
      expect(ledger.listWebhookDeliveries({ limit: 10 })).toEqual([])
      expect(ledger.claimNextWebhookDelivery(now + 900_000)).toBeNull()
    }
  )

  it.each([0, MAX_RETRY_AFTER_MS])('accepts retryAfterMs at the %i boundary', (retryAfterMs) => {
    expect(ledger.claimNextWebhookDelivery(0)?.id).toBe(id)
    const wait = Math.max(30_000, retryAfterMs)

    expect(
      ledger.markWebhookDeliveryFailed(id, { code: 'api-rate-limited', nowMs: 0, retryAfterMs })
    ).toEqual({ ok: true, state: 'pending', retryAtMs: wait })

    expect(ledger.claimNextWebhookDelivery(wait - 1)).toBeNull()
    expect(ledger.claimNextWebhookDelivery(wait)?.id).toBe(id)
  })

  it('rejects claim timestamp overflow before incrementing attempts or writing an unsafe lease', () => {
    expect(() => ledger.claimNextWebhookDelivery(Number.MAX_SAFE_INTEGER - 29_999)).toThrow()

    expect(ledger.claimNextWebhookDelivery(0)?.id).toBe(id)
    expect(ledger.markWebhookDeliveryFailed(id, { code: 'api-network', nowMs: 0 })).toEqual({
      ok: true,
      state: 'pending',
      retryAtMs: 30_000
    })
  })

  it('rejects retry timestamp overflow without replacing the safe claim lease', () => {
    expect(ledger.claimNextWebhookDelivery(0)?.id).toBe(id)

    expect(() =>
      ledger.markWebhookDeliveryFailed(id, {
        code: 'api-rate-limited',
        nowMs: Number.MAX_SAFE_INTEGER - 29_999,
        retryAfterMs: 0
      })
    ).toThrow()

    expect(ledger.claimNextWebhookDelivery(29_999)).toBeNull()
    expect(ledger.claimNextWebhookDelivery(30_000)?.id).toBe(id)
  })

  it('accepts a claim and retry whose timestamp sum is exactly the largest safe integer', () => {
    const now = Number.MAX_SAFE_INTEGER - MAX_RETRY_AFTER_MS
    expect(ledger.claimNextWebhookDelivery(now)?.id).toBe(id)

    expect(
      ledger.markWebhookDeliveryFailed(id, {
        code: 'api-rate-limited',
        nowMs: now,
        retryAfterMs: MAX_RETRY_AFTER_MS
      })
    ).toEqual({ ok: true, state: 'pending', retryAtMs: Number.MAX_SAFE_INTEGER })
    expect(ledger.claimNextWebhookDelivery(Number.MAX_SAFE_INTEGER - 1)).toBeNull()
  })
})
