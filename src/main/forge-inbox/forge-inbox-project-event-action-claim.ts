import { randomUUID } from 'node:crypto'
import {
  PROJECT_EVENT_DECISION_ACTIONS,
  type ProjectEventDecisionAction
} from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { blockAction } from './forge-inbox-project-event-action-settle'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action-types'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { projectEventDispatchCapacitySql } from './forge-inbox-project-event-dispatch-capacity'
import { MAX_QUESTION_TASKS } from './forge-inbox-project-event-question-task'
import { rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeWebhookWorkSchedule } from './forge-inbox-webhook-delivery-state'

/** Actions with an executor in this build; anything else stays queued until one is wired. */
export const PROJECT_EVENT_WIRED_ACTIONS = [
  'notify',
  'wait',
  'fetch_context',
  'dispatch_agent',
  'ask_user'
] as const

/**
 * An ask_user whose one follow-up task declined asks the person itself; no slot or turn is needed.
 * The declined task waits for its claim by the run that produced it, so its claimable set does not
 * read as zero pending work while the watch is still settling.
 */
const QUESTION_TASK_PENDING_SQL = `EXISTS (SELECT 1 FROM project_event_question_attempts a
  WHERE a.delivery_id = d.delivery_id AND a.attempts = ${MAX_QUESTION_TASKS})`

/** An ask_user whose one follow-up task declined asks the person itself; no slot or turn is needed. */
const QUESTION_TASK_DECLINED_SQL = `EXISTS (SELECT 1 FROM project_event_question_attempts a
  WHERE a.delivery_id = d.delivery_id AND a.attempts > ${MAX_QUESTION_TASKS})`

function queuedActionSql(actions: readonly ProjectEventDecisionAction[]): string {
  return `d.host_id = ? AND d.action_state = 'queued' AND d.action <> 'record_only'
    AND d.action IN (${actions.map(() => '?').join(', ')})
    AND d.superseded = 0 AND w.binding_id IS NOT NULL
    AND ((d.action <> 'dispatch_agent' AND (d.action <> 'ask_user' OR EXISTS (
      SELECT 1 FROM project_event_questions q WHERE q.host_id = d.host_id AND q.delivery_id = d.delivery_id
    ) OR ${QUESTION_TASK_DECLINED_SQL} OR ${QUESTION_TASK_PENDING_SQL})) OR (
      ${projectEventDispatchCapacitySql('d.host_id')}))`
}

export function getProjectEventActionSchedule(
  ctx: ForgeLedgerContext,
  actions: readonly ProjectEventDecisionAction[] = PROJECT_EVENT_WIRED_ACTIONS
): ForgeWebhookWorkSchedule {
  if (actions.length === 0) {
    return { pending: 0, needsAuth: 0, nextAttemptAtMs: null }
  }
  // Exactly the claimable set: a looser count would keep the scheduler armed with nothing to take.
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS pending FROM project_event_decisions d
    JOIN webhook_deliveries w ON w.id = d.delivery_id
    LEFT JOIN project_bindings b ON b.binding_id = w.binding_id
    WHERE ${queuedActionSql(actions)}`)
    .get(ctx.hostId, ...actions)
  const pending = row ? rowNumber(row, 'pending') : 0
  // A null nextAttemptAtMs leaves the worker scheduler unarmed, so queued work must be due now.
  return { pending, needsAuth: 0, nextAttemptAtMs: pending > 0 ? ctx.now() : null }
}

export function claimProjectEventAction(
  ctx: ForgeLedgerContext,
  actions: readonly ProjectEventDecisionAction[] = PROJECT_EVENT_WIRED_ACTIONS
): ProjectEventActionClaim | null {
  if (actions.length === 0) {
    return null
  }
  // Avoid publishing an empty transaction hint back into the owner's wake subscription.
  if (
    !ctx.db
      .prepare(
        `SELECT 1 FROM project_event_decisions d JOIN webhook_deliveries w ON w.id = d.delivery_id
        LEFT JOIN project_bindings b ON b.binding_id = w.binding_id
        WHERE ${queuedActionSql(actions)} LIMIT 1`
      )
      .get(ctx.hostId, ...actions)
  ) {
    return null
  }
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT d.id AS decision_id, d.delivery_id, d.action, d.item_id, d.policy_generation,
        w.binding_id FROM project_event_decisions d
        JOIN webhook_deliveries w ON w.id = d.delivery_id
        LEFT JOIN project_bindings b ON b.binding_id = w.binding_id
        WHERE ${queuedActionSql(actions)} ORDER BY d.id LIMIT 1`
      )
      .get(ctx.hostId, ...actions)
    if (!row) {
      return null
    }
    const decisionId = rowNumber(row, 'decision_id')
    const deliveryId = rowNumber(row, 'delivery_id')
    const action = PROJECT_EVENT_DECISION_ACTIONS.find(
      (candidate) => candidate === rowText(row, 'action')
    )
    if (!action) {
      blockAction(ctx, decisionId, deliveryId, 'invalid-action')
      return null
    }
    const bindingId = rowText(row, 'binding_id')
    const link = getProjectEventRepoLinkByBinding(ctx, bindingId)
    if (!link) {
      blockAction(ctx, decisionId, deliveryId, 'missing-link')
      return null
    }
    const token = randomUUID()
    const startedAt = ctx.now()
    ctx.db
      .prepare(`UPDATE project_event_decisions SET action_state = 'processing', action_token = ?,
      action_started_at = ? WHERE id = ?`)
      .run(token, startedAt, decisionId)
    return {
      decisionId,
      deliveryId: rowNumber(row, 'delivery_id'),
      action,
      itemId: row.item_id === null ? null : rowNumber(row, 'item_id'),
      token,
      startedAt,
      bindingId,
      repoId: link.repoId,
      generation: rowNumber(row, 'policy_generation')
    }
  })
}
