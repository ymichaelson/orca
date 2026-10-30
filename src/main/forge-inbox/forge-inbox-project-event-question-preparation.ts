import type { ProjectEventQuestionSource } from '../../shared/forge-inbox-project-event-question'
import type { ForgeRun } from '../../shared/forge-inbox-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { recordForgeChange } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { settleDispatchConfirmationNoClaim } from './forge-inbox-dispatch-confirmation'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import { parseQuestionProof } from './forge-inbox-project-event-question-proof'
import { MAX_QUESTION_TASKS } from './forge-inbox-project-event-question-task'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { rowNumber, rowText } from './forge-inbox-rows'
import { applyTransition, readForgeRun } from './forge-inbox-runs'
import { finishForgeWebhookDelivery } from './forge-inbox-webhook-delivery-state'

/** The host's copy for a question no task could prepare; readers that know the source localize it. */
const EXHAUSTED_QUESTION = '需要你确认：是否要由你直接决定接下来怎么处理这个事件？'
const FAILED_QUESTION_PREPARATION = 'dispatch-unverifiable'

/** What a delivery's next ask_user drain may do: prepare, run its one minimum task, or ask directly. */
export function projectEventQuestionAttempts(
  ctx: ForgeLedgerContext,
  deliveryId: number
): 'prepare' | 'answer' | 'exhausted' {
  const row = ctx.db
    .prepare('SELECT attempts FROM project_event_question_attempts WHERE delivery_id = ?')
    .get(deliveryId)
  if (row === undefined) {
    return 'prepare'
  }
  const declined = Number(row.attempts)
  return declined > MAX_QUESTION_TASKS ? 'exhausted' : 'answer'
}

function markQuestionTaskDeclined(
  ctx: ForgeLedgerContext,
  deliveryId: number,
  decisionId: number
): void {
  ctx.db
    .prepare(
      `INSERT INTO project_event_question_attempts (delivery_id, decision_id, attempts)
      VALUES (?, ?, 1) ON CONFLICT (delivery_id) DO UPDATE SET
      attempts = project_event_question_attempts.attempts + 1,
      decision_id = excluded.decision_id`
    )
    .run(deliveryId, decisionId)
}

/** A turn that never started fails its delivery, unless the owed task still owes the person a question. */
export function failQuestionTurn(ctx: ForgeLedgerContext, runId: number, code: string): void {
  runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(`SELECT d.id, d.delivery_id, d.item_id FROM project_event_decisions d
      JOIN webhook_deliveries w ON w.id = d.delivery_id AND w.host_id = d.host_id
      WHERE d.run_id = ? AND d.host_id = ? AND d.action = 'ask_user' AND d.superseded = 0
        AND d.action_state = 'blocked' AND w.state = 'parked'
        AND w.parked_reason = 'preparing-question'`)
      .get(runId, ctx.hostId)
    if (!row) {
      return
    }
    const deliveryId = rowNumber(row, 'delivery_id')
    const decisionId = rowNumber(row, 'id')
    if (projectEventQuestionAttempts(ctx, deliveryId) === 'answer') {
      // No second task is coming, so the host asks the person itself rather than going quiet.
      markQuestionTaskDeclined(ctx, deliveryId, decisionId)
      publishQuestion(ctx, decisionId, rowNumber(row, 'item_id'), deliveryId, 'exhausted')
      return
    }
    ctx.db
      .prepare(`UPDATE project_event_decisions SET last_error_code = ?, action_finished_at = ?
      WHERE id = ?`)
      .run(code, ctx.now(), decisionId)
    finishForgeWebhookDelivery(ctx, deliveryId, 'failed', code)
  })
}

/**
 * A preparation whose proof never arrives stays open for a late exact proof, but stops reading as
 * running so its parked delivery is no longer waiting on a turn that may never be observed again.
 */
export function markQuestionPreparationUnproven(ctx: ForgeLedgerContext, runId: number): boolean {
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT r.state, r.session_id, r.dispatch_client_message_id
         FROM project_event_decisions d JOIN runs r ON r.id = d.run_id
         WHERE d.host_id = ? AND d.run_id = ? AND d.action = 'ask_user' LIMIT 1`
      )
      .get(ctx.hostId, runId)
    if (
      !row ||
      row.state !== 'running' ||
      row.session_id === null ||
      row.dispatch_client_message_id === null
    ) {
      return false
    }
    const run = readForgeRun(ctx, runId)
    if (!run) {
      return false
    }
    return applyTransition(ctx, run, { to: 'unverifiable', error: 'unknown-outcome' }).ok
  })
}

function settleRun(
  ctx: ForgeLedgerContext,
  run: ForgeRun,
  runId: number,
  state: 'succeeded' | 'failed'
): boolean {
  if (run.state === 'running') {
    return applyTransition(ctx, run, {
      to: state,
      ...(state === 'failed' ? { error: FAILED_QUESTION_PREPARATION } : {})
    }).ok
  }
  ctx.db
    .prepare(`UPDATE runs SET state = ?, generation = generation + 1, error = ?, updated_at = ?
    WHERE id = ? AND state = 'unverifiable' AND error = 'unknown-outcome'`)
    .run(state, state === 'failed' ? FAILED_QUESTION_PREPARATION : null, ctx.now(), runId)
  recordForgeChange(ctx, run.itemId, 'run', runId, state)
  return true
}

function failAttempt(
  ctx: ForgeLedgerContext,
  deliveryId: number,
  decisionId: number,
  code: string
): void {
  ctx.db
    .prepare(
      `UPDATE project_event_decisions SET last_error_code = ?, action_finished_at = ? WHERE id = ?`
    )
    .run(code, ctx.now(), decisionId)
  finishForgeWebhookDelivery(ctx, deliveryId, 'failed', code)
}

/** Returns false only when the run belongs to ordinary dispatch. */
export function settleQuestionPreparation(
  ctx: ForgeLedgerContext,
  runId: number,
  sessionId: string,
  clientMessageId: string,
  proof: ForgeProtectedTurnProof | null
): boolean {
  return runForgeTransaction(ctx.db, (): boolean => {
    const row = ctx.db
      .prepare(`SELECT d.id, d.delivery_id, d.item_id, d.policy_generation,
      d.superseded, d.action_state, w.binding_id, w.state AS delivery_state, w.parked_reason,
      r.state AS run_state, r.error, r.session_id, r.dispatch_client_message_id,
      r.cancel_requested_at, r.context_digest, head.version_token
      FROM project_event_decisions d
      JOIN webhook_deliveries w ON w.id = d.delivery_id AND w.host_id = d.host_id
      JOIN runs r ON r.id = d.run_id AND r.item_id = d.item_id
      JOIN items i ON i.id = r.item_id AND i.host_id = d.host_id
      JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
      WHERE d.host_id = ? AND d.run_id = ? AND d.action = 'ask_user' LIMIT 1`)
      .get(ctx.hostId, runId)
    if (!row) {
      return false
    }
    const run = readForgeRun(ctx, runId)
    const open =
      run?.state === 'running' || (run?.state === 'unverifiable' && run.error === 'unknown-outcome')
    if (
      !run ||
      proof === null ||
      row.session_id !== sessionId ||
      row.dispatch_client_message_id !== clientMessageId ||
      !proof.terminal ||
      !open
    ) {
      return true
    }
    const link = getProjectEventRepoLinkByBinding(ctx, rowText(row, 'binding_id'))
    const policy = link ? getProjectEventPolicy(ctx, link.repoId) : null
    const current =
      rowNumber(row, 'superseded') === 0 &&
      row.action_state === 'blocked' &&
      row.delivery_state === 'parked' &&
      row.parked_reason === 'preparing-question' &&
      row.cancel_requested_at === null &&
      row.context_digest === row.version_token &&
      policy?.enabled === true &&
      policy.generation === rowNumber(row, 'policy_generation')
    const parsed = current && proof.outcome === 'success' ? parseQuestionProof(proof.text) : null
    if (!settleRun(ctx, run, runId, parsed !== null ? 'succeeded' : 'failed')) {
      return true
    }
    settleDispatchConfirmationNoClaim(ctx, runId)
    const deliveryId = rowNumber(row, 'delivery_id')
    const decisionId = rowNumber(row, 'id')
    if (!current) {
      if (
        rowNumber(row, 'superseded') === 0 &&
        row.action_state === 'blocked' &&
        row.delivery_state === 'parked' &&
        row.parked_reason === 'preparing-question'
      ) {
        const code =
          row.context_digest !== row.version_token ? 'head-moved' : FAILED_QUESTION_PREPARATION
        failAttempt(ctx, deliveryId, decisionId, code)
      }
      return true
    }
    if (parsed?.kind === 'question') {
      publishQuestion(
        ctx,
        decisionId,
        rowNumber(row, 'item_id'),
        deliveryId,
        'answer',
        parsed.question
      )
      return true
    }
    if (parsed?.kind !== 'declined') {
      failAttempt(ctx, deliveryId, decisionId, FAILED_QUESTION_PREPARATION)
      return true
    }
    markQuestionTaskDeclined(ctx, deliveryId, decisionId)
    if (projectEventQuestionAttempts(ctx, deliveryId) === 'exhausted') {
      // The person still gets a question: a task that declined is no reason to leave them silent.
      publishQuestion(ctx, decisionId, rowNumber(row, 'item_id'), deliveryId, 'exhausted')
      return true
    }
    // Re-queued, not blocked: the next drain owes this delivery its one minimum task.
    ctx.db
      .prepare(`UPDATE project_event_decisions SET action_state = 'queued',
      last_error_code = 'preparing-question', action_token = NULL, action_finished_at = ?
      WHERE id = ? AND host_id = ?`)
      .run(ctx.now(), decisionId, ctx.hostId)
    return true
  })
}

/** An open question parks its delivery for a person; the source says what the preparation could not. */
function publishQuestion(
  ctx: ForgeLedgerContext,
  decisionId: number,
  itemId: number,
  deliveryId: number,
  source: ProjectEventQuestionSource,
  asked: string | null = null
): void {
  const item = ctx.db
    .prepare('SELECT kind, iid, title FROM items WHERE id = ? AND host_id = ?')
    .get(itemId, ctx.hostId)
  if (!item) {
    return
  }
  ctx.db
    .prepare(`INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id,
    question, status, asked_at, subject_kind, subject_iid, subject_title, source)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
    .run(
      ctx.hostId,
      deliveryId,
      decisionId,
      itemId,
      asked ?? EXHAUSTED_QUESTION,
      ctx.now(),
      rowText(item, 'kind'),
      rowNumber(item, 'iid'),
      rowText(item, 'title'),
      source
    )
  ctx.db
    .prepare(`UPDATE webhook_deliveries SET parked_reason = 'awaiting-user' WHERE id = ?`)
    .run(deliveryId)
  ctx.db
    .prepare(
      `UPDATE project_event_decisions SET last_error_code = 'awaiting-user', action_finished_at = ? WHERE id = ?`
    )
    .run(ctx.now(), decisionId)
}
