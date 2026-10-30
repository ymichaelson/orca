import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { rowNumber, rowText } from './forge-inbox-rows'
import {
  FORGE_WEBHOOK_MAX_BODY_BYTES,
  getForgeWebhookQueueStatus,
  type ForgeWebhookQueueLimits
} from './forge-inbox-webhook-queue'

const DELIVERY_STATES = ['pending', 'parked', 'done', 'failed', 'needs-auth'] as const

export type ProjectEventDeliveryState = (typeof DELIVERY_STATES)[number]

export type ProjectEventDeliveryAdmission = {
  bindingId: string
  projectPath: string
  /** Null when the binding has no project policy yet, which parks the delivery. */
  policyGeneration: number | null
  policyEnabled: boolean
  eventKind: string
  dedupeKey: string
  correlation: { eventUuid: string | null; configUuid: string | null }
  body: Buffer
}

export type ProjectEventDeliveryAdmissionResult =
  | { ok: true; duplicate: boolean; deliveryId: number; state: ProjectEventDeliveryState }
  | { ok: false; reason: 'body-too-large' | 'queue-full' }

function storedState(value: string): ProjectEventDeliveryState {
  const found = DELIVERY_STATES.find((state) => state === value)
  if (!found) {
    throw new Error('forge inbox project event delivery has an unknown state')
  }
  return found
}

/**
 * A binding event is admitted for one policy generation: parked while the project has no policy, and
 * finished at once while the policy is off, so turning it on never replays history.
 */
export function admitProjectEventDelivery(
  ctx: ForgeLedgerContext,
  limits: ForgeWebhookQueueLimits,
  input: ProjectEventDeliveryAdmission
): ProjectEventDeliveryAdmissionResult {
  if (input.body.length > FORGE_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, reason: 'body-too-large' }
  }
  return runForgeTransaction(ctx.db, (): ProjectEventDeliveryAdmissionResult => {
    const existing = ctx.db
      .prepare(
        `SELECT id, state FROM webhook_deliveries
         WHERE host_id = ? AND binding_id = ? AND dedupe_key = ?`
      )
      .get(ctx.hostId, input.bindingId, input.dedupeKey)
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        deliveryId: rowNumber(existing, 'id'),
        state: storedState(rowText(existing, 'state'))
      }
    }
    const state: ProjectEventDeliveryState =
      input.policyGeneration === null ? 'parked' : input.policyEnabled ? 'pending' : 'done'
    if (state !== 'done') {
      const status = getForgeWebhookQueueStatus(ctx, limits)
      if (
        (state === 'pending' && status.pending + 1 > limits.maxPending) ||
        status.queuedBytes + input.body.length > limits.maxQueuedBytes
      ) {
        return { ok: false, reason: 'queue-full' }
      }
    }
    const finishedAt = state === 'done' ? ctx.now() : null
    const inserted = ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
           event_uuid, config_uuid, policy_generation, admitted_at, state, parked_reason,
           finished_at, body, decision_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ctx.hostId,
        input.bindingId,
        input.projectPath,
        input.dedupeKey,
        input.eventKind,
        input.correlation.eventUuid,
        input.correlation.configUuid,
        state === 'parked' ? null : input.policyGeneration,
        ctx.now(),
        state,
        state === 'parked' ? 'awaiting-policy' : null,
        finishedAt,
        state === 'done' ? Buffer.alloc(0) : input.body,
        state === 'done' ? 'cancelled' : state === 'parked' ? 'blocked' : 'queued'
      )
    return {
      ok: true,
      duplicate: false,
      deliveryId: rowNumber({ v: inserted.lastInsertRowid }, 'v'),
      state
    }
  })
}

/**
 * One statement, so it is safe inside a caller transaction: an enabled policy or a newly linked
 * repository must never leave a parked delivery behind. A delivery a waiting action already decided
 * is not awaiting a policy at all — waking it would decide the same event twice.
 */
export function resumeParkedProjectEventDeliveries(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; policyGeneration: number }
): number {
  return Number(
    ctx.db
      .prepare(
        `UPDATE webhook_deliveries
         SET state = 'pending', decision_state = 'queued', parked_reason = NULL, policy_generation = ?
         WHERE host_id = ? AND binding_id = ? AND state = 'parked'
           AND decision_state <> 'decided'`
      )
      .run(input.policyGeneration, ctx.hostId, input.bindingId).changes
  )
}
