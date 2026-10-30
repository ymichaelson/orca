import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import type {
  ProjectEventActionClaim,
  ProjectEventActionOutcome,
  ProjectEventActionSettleResult,
  ProjectEventQuestionPrompt
} from './forge-inbox-project-event-action-types'
import { rowNumber, rowText } from './forge-inbox-rows'
import {
  assertForgeWebhookErrorCode,
  finishForgeWebhookDelivery
} from './forge-inbox-webhook-delivery-state'

const MAX_WAIT_REASON_LENGTH = 200

export function blockAction(
  ctx: ForgeLedgerContext,
  decisionId: number,
  deliveryId: number,
  code: string
): void {
  assertForgeWebhookErrorCode(code)
  ctx.db
    .prepare(`UPDATE project_event_decisions SET action_state = 'blocked', last_error_code = ?,
    action_token = NULL, action_finished_at = ? WHERE id = ? AND host_id = ?`)
    .run(code, ctx.now(), decisionId, ctx.hostId)
  finishDelivery(ctx, deliveryId, 'failed', code)
}

/**
 * A policy edit superseded an in-flight decision; its delivery now belongs to the new decision, so the
 * abandoned action is cancelled without finishing that delivery.
 */
export function cancelSupersededAction(ctx: ForgeLedgerContext, decisionId: number): void {
  ctx.db
    .prepare(`UPDATE project_event_decisions SET action_state = 'cancelled',
    action_token = NULL, action_finished_at = ? WHERE id = ? AND host_id = ?`)
    .run(ctx.now(), decisionId, ctx.hostId)
}

export function finishDelivery(
  ctx: ForgeLedgerContext,
  deliveryId: number,
  outcome: 'done' | 'failed',
  code: string | null
): void {
  if (!finishForgeWebhookDelivery(ctx, deliveryId, outcome, code)) {
    throw new Error(`project event action for delivery ${deliveryId} has no delivery row`)
  }
}

function questionItemId(ctx: ForgeLedgerContext, claim: ProjectEventActionClaim): number | null {
  const row = ctx.db
    .prepare('SELECT item_id FROM project_event_decisions WHERE id = ? AND host_id = ?')
    .get(claim.decisionId, ctx.hostId)
  return row && row.item_id !== null ? rowNumber(row, 'item_id') : null
}

/** Insert only after the delivery is parked: an orphan question could never be answered. */
function openQuestion(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  itemId: number,
  question: ProjectEventQuestionPrompt
): void {
  ctx.db
    .prepare(`INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id,
    question, subject_kind, subject_iid, subject_title, status, asked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(
      ctx.hostId,
      claim.deliveryId,
      claim.decisionId,
      itemId,
      question.text,
      question.subject.kind,
      question.subject.iid,
      question.subject.title,
      ctx.now()
    )
}

type ProjectEventSettleFields = {
  actionState: 'done' | 'awaiting-event' | 'blocked'
  parkedReason: string | null
  code: string | null
}

/** One place maps an outcome to what the delivery and decision rows record. */
function projectEventSettleFields(
  outcome: Exclude<ProjectEventActionOutcome, { kind: 'queued' }>
): ProjectEventSettleFields {
  if (outcome.kind === 'awaiting-event') {
    return {
      actionState: 'awaiting-event',
      parkedReason: outcome.waitReason.slice(0, MAX_WAIT_REASON_LENGTH),
      code: null
    }
  }
  if (outcome.kind === 'awaiting-user') {
    return { actionState: 'blocked', parkedReason: 'awaiting-user', code: 'awaiting-user' }
  }
  if (outcome.kind === 'blocked') {
    return { actionState: 'blocked', parkedReason: null, code: outcome.code }
  }
  return { actionState: 'done', parkedReason: null, code: null }
}

export function settleProjectEventAction(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  outcome: ProjectEventActionOutcome,
  question?: ProjectEventQuestionPrompt
): ProjectEventActionSettleResult {
  return runForgeTransaction(ctx.db, (): ProjectEventActionSettleResult => {
    const held = ctx.db
      .prepare(`SELECT superseded FROM project_event_decisions WHERE id = ? AND host_id = ?
      AND action_token = ? AND action_state = 'processing'`)
      .get(claim.decisionId, ctx.hostId, claim.token)
    if (!held) {
      return { ok: false, reason: 'not-found' }
    }
    if (rowNumber(held, 'superseded') !== 0) {
      cancelSupersededAction(ctx, claim.decisionId)
      return { ok: false, reason: 'not-found' }
    }
    if (outcome.kind === 'queued') {
      ctx.db
        .prepare(`UPDATE project_event_decisions SET action_state = 'queued',
        action_token = NULL, action_started_at = NULL WHERE id = ? AND host_id = ?`)
        .run(claim.decisionId, ctx.hostId)
      return { ok: true, actionState: 'queued' }
    }
    const now = ctx.now()
    const { actionState, parkedReason, code } = projectEventSettleFields(outcome)
    const itemId =
      outcome.kind === 'awaiting-user' && question !== undefined ? questionItemId(ctx, claim) : null
    if (outcome.kind === 'awaiting-user' && question !== undefined && itemId === null) {
      return { ok: false, reason: 'not-found' }
    }
    if (parkedReason !== null) {
      // Parked, so the wait keeps its payload for the waking event but stops holding a pending slot.
      const parked = ctx.db
        .prepare(`UPDATE webhook_deliveries SET state = 'parked', parked_reason = ?,
        next_attempt_at = NULL WHERE id = ? AND host_id = ? AND finished_at IS NULL`)
        .run(parkedReason, claim.deliveryId, ctx.hostId)
      if (parked.changes !== 1) {
        return { ok: false, reason: 'not-found' }
      }
    } else {
      // A settled action owns its delivery's outcome: leaving it pending would hold a queue slot and
      // its payload forever, until admission starts refusing every new event.
      finishDelivery(
        ctx,
        claim.deliveryId,
        outcome.kind === 'done' ? 'done' : 'failed',
        outcome.kind === 'blocked' ? outcome.code : null
      )
    }
    if (outcome.kind === 'awaiting-user' && question !== undefined && itemId !== null) {
      openQuestion(ctx, claim, itemId, question)
    }
    const runId = outcome.kind === 'done' ? (outcome.runId ?? null) : null
    ctx.db
      .prepare(`UPDATE project_event_decisions SET action_state = ?, action_token = NULL,
      action_finished_at = ?, last_error_code = ?, run_id = COALESCE(?, run_id)
      WHERE id = ? AND host_id = ? AND superseded = 0`)
      .run(actionState, now, code, runId, claim.decisionId, ctx.hostId)
    return { ok: true, actionState }
  })
}

export function recoverInterruptedProjectEventActions(ctx: ForgeLedgerContext): void {
  runForgeTransaction(ctx.db, () => {
    // The dead claim's token is about to be cleared, so its delivery can never be settled after this.
    const interrupted = ctx.db
      .prepare(`SELECT id, delivery_id, superseded, action FROM project_event_decisions
      WHERE host_id = ? AND action_state = 'processing'`)
      .all(ctx.hostId)
    for (const row of interrupted) {
      const decisionId = rowNumber(row, 'id')
      if (rowNumber(row, 'superseded') !== 0) {
        // The re-decision owns this delivery now; finishing it here would erase that decision's body.
        cancelSupersededAction(ctx, decisionId)
        continue
      }
      // A dispatch may already have launched, so its interruption is unknowable, not ordinary.
      const code =
        rowText(row, 'action') === 'dispatch_agent' ? 'dispatch-unverifiable' : 'interrupted-action'
      finishDelivery(ctx, rowNumber(row, 'delivery_id'), 'failed', code)
      ctx.db
        .prepare(`UPDATE project_event_decisions SET action_state = 'blocked',
        last_error_code = ?, action_token = NULL, action_finished_at = ?
        WHERE id = ?`)
        .run(code, ctx.now(), decisionId)
    }
  })
}
