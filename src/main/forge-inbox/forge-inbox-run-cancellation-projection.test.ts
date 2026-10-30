import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgeItemHandling, readForgeItemHandling } from './forge-inbox-item-handling'
import {
  CANCEL_REPO_ID,
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { projectForgeItemDetail, projectForgeRunPage } from './forge-inbox-read-projection'
import {
  readRunCancellationViews,
  recordRunCancelDelivery
} from './forge-inbox-project-event-run-cancel-state'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

describe('a requested stop is projected as a request, never as a stop', () => {
  let fx: DispatchLedgerFixture
  beforeEach(() => {
    fx = openDispatchLedger()
  })
  afterEach(() => fx.dispose())

  function itemOf(runId: number): number {
    return Number(
      fx.ledger.ledgerContext().db.prepare('SELECT item_id FROM runs WHERE id = ?').get(runId)
        ?.item_id
    )
  }

  it('adds only the request time and how far it got to the run, and the item reads as stopping', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    const row = runRow(fx.ledger, runId)

    const detail = fx.ledger.getItemDetail(SCOPE, itemOf(runId), 'client-1')
    if (!detail) {
      throw new Error('expected the item detail')
    }
    const view = projectForgeItemDetail(detail)

    expect(view.runs[0]?.cancellation).toEqual({
      requestedAt: row.cancel_requested_at,
      delivery: 'pending'
    })
    expect(view.runs[0]?.state).toBe('running')
    expect(view.handling).toEqual({ state: 'processing', errorCode: null, stopping: true })
    // Internal identity never leaves the host.
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(String(row.cancel_operation_id))
    expect(serialized).not.toContain('cancel_fence')
    expect(serialized).not.toContain('cancelOperation')
  })

  it('shows what the host did with the request', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    const ctx = fx.ledger.ledgerContext()
    const row = runRow(fx.ledger, runId)
    const request = {
      runId,
      itemId: itemOf(runId),
      operationId: String(row.cancel_operation_id)
    }

    for (const delivery of ['accepted', 'refused', 'unreachable'] as const) {
      recordRunCancelDelivery(ctx, request, delivery, 7)
      expect(readRunCancellationViews(ctx, [runId]).get(runId)?.delivery).toBe(delivery)
    }
    ctx.db.prepare('UPDATE runs SET cancel_delivery = ? WHERE id = ?').run('mystery', runId)
    expect(readRunCancellationViews(ctx, [runId]).get(runId)?.delivery).toBe('pending')
  })

  it('does not record a delivery for another request, or for a run that settled', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    const ctx = fx.ledger.ledgerContext()
    const request = { runId, itemId: itemOf(runId), operationId: 'someone-elses' }

    expect(recordRunCancelDelivery(ctx, request, 'accepted', 7)).toBe(false)
    expect(runRow(fx.ledger, runId).cancel_delivery).toBeNull()

    ctx.db.prepare("UPDATE runs SET state = 'succeeded' WHERE id = ?").run(runId)
    expect(
      recordRunCancelDelivery(
        ctx,
        { ...request, operationId: String(runRow(fx.ledger, runId).cancel_operation_id) },
        'accepted',
        7
      )
    ).toBe(false)
  })

  it('leaves a run nobody asked to stop exactly as before', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const detail = fx.ledger.getItemDetail(SCOPE, itemOf(runId), 'client-1')
    if (!detail) {
      throw new Error('expected the item detail')
    }
    const view = projectForgeItemDetail(detail)

    expect(view.runs[0]).not.toHaveProperty('cancellation')
    expect(view.handling).toEqual({ state: 'processing', errorCode: null })
    expect(readForgeItemHandling(fx.ledger.ledgerContext(), itemOf(runId))).toEqual({
      state: 'processing',
      errorCode: null
    })
  })

  it('pages carry the request and a settled run no longer reads as stopping', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    const ctx = fx.ledger.ledgerContext()
    const page = fx.ledger.listRuns(SCOPE, { itemId: itemOf(runId) })

    const projected = projectForgeRunPage(page, new Map(), readRunCancellationViews(ctx, [runId]))
    expect(projected.rows[0]?.cancellation?.delivery).toBe('pending')

    ctx.db
      .prepare("UPDATE runs SET state = 'cancelled', error = 'cancelled' WHERE id = ?")
      .run(runId)
    expect(readForgeItemHandling(ctx, itemOf(runId))).not.toHaveProperty('stopping')
  })

  it('never reads an interrupted or queued run as stopping', () => {
    const base = {
      openQuestions: 0,
      pendingProposals: 0,
      unknownReceipts: 0,
      unresolvedDispatches: 0,
      action: null,
      actionError: null,
      deliveryState: null,
      parkedReason: null,
      deliveryError: null,
      runStopRequested: true
    }

    expect(forgeItemHandling({ ...base, runState: 'queued' })).toEqual({
      state: 'processing',
      errorCode: null
    })
    expect(forgeItemHandling({ ...base, runState: 'unverifiable' }).state).toBe('unconfirmed')
  })
})
