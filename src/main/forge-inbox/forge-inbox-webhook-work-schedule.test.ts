import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'
import {
  API_TOKEN,
  createWorkerRig,
  mergeRequestHookBody,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

describe('forge inbox webhook work schedule', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  const admitOne = () => rig.admit('merge_request', mergeRequestHookBody())
  const claim = () => {
    const delivery = rig.ledger.claimNextWebhookDelivery(rig.ledger.nowMs())
    if (!delivery) {
      throw new Error('nothing to claim')
    }
    return delivery
  }

  it('reports nothing for an empty queue', () => {
    rig = createWorkerRig()

    expect(rig.ledger.getWebhookWorkSchedule()).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
  })

  it('counts pending and needs-auth rows and reports the earliest persisted attempt time', () => {
    rig = createWorkerRig()
    const first = admitOne()
    admitOne()
    admitOne()
    const stuck = claim()
    claim()
    rig.ledger.markWebhookDeliveryNeedsAuth(stuck.id)

    const leased = rig
      .deliveries()
      .find((row) => row.state === 'pending' && row.next_attempt_at !== null)
    expect(first).toBe(stuck.id)

    const schedule = rig.ledger.getWebhookWorkSchedule()
    expect(schedule).toMatchObject({ pending: 2, needsAuth: 1 })
    expect(schedule.nextAttemptAtMs).toBeLessThan(Number(leased?.next_attempt_at))
    expect(schedule.nextAttemptAtMs).toBeLessThanOrEqual(rig.ledger.nowMs())
  })

  it('reports a never-attempted row as due no later than now and ignores finished rows', () => {
    rig = createWorkerRig()
    const id = admitOne()

    const waiting = rig.ledger.getWebhookWorkSchedule()
    expect(waiting.pending).toBe(1)
    expect(waiting.nextAttemptAtMs).toBeLessThanOrEqual(rig.ledger.nowMs())

    rig.ledger.markWebhookDeliveryDone(id)
    expect(rig.ledger.getWebhookWorkSchedule()).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
  })

  it('keeps the persisted retry time across a reopen', () => {
    rig = createWorkerRig()
    const delivery = (admitOne(), claim())
    const failed = rig.ledger.markWebhookDeliveryFailed(delivery.id, {
      code: 'api-network',
      nowMs: rig.ledger.nowMs()
    })
    if (!failed.ok || failed.state !== 'pending') {
      throw new Error('expected a scheduled retry')
    }

    const reopened = rig.restart()

    expect(reopened.getWebhookWorkSchedule()).toEqual({
      pending: 1,
      needsAuth: 0,
      nextAttemptAtMs: failed.retryAtMs
    })
  })

  describe('api-read credential rotation', () => {
    const park = () => {
      admitOne()
      rig.ledger.markWebhookDeliveryNeedsAuth(claim().id)
    }
    const rotate = (kind: 'api-read' | 'webhook' | 'api-write', offset = 0) =>
      rig.ledger.setCredential({
        instanceId: INSTANCE_ID,
        kind,
        secret: 'glpat-rotated',
        expectedRevision: rig.ledger.getConfig().configRevision + offset
      })

    it('requeues that instance needs-auth rows in the same call with attempts reset', () => {
      rig = createWorkerRig()
      park()

      expect(rotate('api-read').ok).toBe(true)

      expect(rig.deliveries()).toMatchObject([
        { state: 'pending', attempts: 0, next_attempt_at: null }
      ])
      expect(rig.ledger.getWebhookWorkSchedule()).toMatchObject({ pending: 1, needsAuth: 0 })
    })

    it.each(['webhook', 'api-write'] as const)('does not requeue for a %s credential', (kind) => {
      rig = createWorkerRig()
      park()

      expect(rotate(kind).ok).toBe(true)

      expect(rig.deliveries()).toMatchObject([{ state: 'needs-auth' }])
    })

    it('does not requeue when the credential write is rejected as stale', () => {
      rig = createWorkerRig()
      park()

      expect(rotate('api-read', -1)).toMatchObject({ ok: false, reason: 'stale-revision' })

      expect(rig.deliveries()).toMatchObject([{ state: 'needs-auth' }])
    })

    it('rolls the credential back when the requeue cannot be written', () => {
      rig = createWorkerRig()
      park()
      const revision = rig.ledger.getConfig().configRevision
      const sabotage = new Database(rig.harness.dbPath)
      sabotage
        .prepare(
          `CREATE TRIGGER refuse_requeue BEFORE UPDATE OF state ON webhook_deliveries
           WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'refused'); END`
        )
        .run()
      sabotage.close()

      expect(() => rotate('api-read')).toThrow()

      expect(rig.ledger.getConfig().configRevision).toBe(revision)
      expect(rig.ledger.readSecret(INSTANCE_ID, 'api-read')?.secret).toBe(API_TOKEN)
      expect(rig.deliveries()).toMatchObject([{ state: 'needs-auth' }])
    })
  })
})
