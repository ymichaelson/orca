import {
  FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES,
  FORGE_PROJECT_EVENT_QUESTION_SOURCES,
  FORGE_PROJECT_EVENT_QUESTION_STATUSES,
  type ProjectEventQuestionAnswerOutcome,
  type ProjectEventQuestionSource,
  type ProjectEventQuestionStatus,
  type ProjectEventQuestionSubject,
  type ProjectEventQuestionView
} from '../../shared/forge-inbox-project-event-question'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { rowNumber, rowText } from './forge-inbox-rows'
import { finishForgeWebhookDelivery } from './forge-inbox-webhook-delivery-state'

export type ProjectEventQuestionAnswerResult = ProjectEventQuestionAnswerOutcome

const MAX_CONTEXT_ANSWERS = 3

function questionStatus(value: string): ProjectEventQuestionStatus {
  return FORGE_PROJECT_EVENT_QUESTION_STATUSES.find((status) => status === value) ?? 'open'
}

/** The RPC bounds the same bytes; this keeps a direct caller from storing an unbounded value. */
function normalizedAnswer(answer: string): string | null {
  const text = answer.replaceAll('\u0000', '')
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES) {
    return null
  }
  return text
}

/** A partially written subject is no subject: the stored text stays the fallback, never a crash. */
function subjectOf(row: SqliteRow): ProjectEventQuestionSubject | null {
  const kind = row.subject_kind
  const iid = row.subject_iid
  const title = row.subject_title
  return typeof kind === 'string' && typeof iid === 'number' && typeof title === 'string'
    ? { kind, iid, title }
    : null
}

/** A row written before the column existed has no source, which reads as the host's own copy. */
function sourceOf(row: SqliteRow): ProjectEventQuestionSource | null {
  const source = row.source
  return FORGE_PROJECT_EVENT_QUESTION_SOURCES.find((known) => known === source) ?? null
}

function viewOf(row: SqliteRow): ProjectEventQuestionView {
  return {
    id: rowNumber(row, 'id'),
    itemId: rowNumber(row, 'item_id'),
    question: rowText(row, 'question'),
    subject: subjectOf(row),
    source: sourceOf(row),
    status: questionStatus(rowText(row, 'status')),
    askedAt: rowNumber(row, 'asked_at'),
    answeredAt: row.answered_at === null ? null : rowNumber(row, 'answered_at')
  }
}

/**
 * The answer is the last write a parked delivery waits for: re-open it with the old decision
 * superseded, or finish it when it can never be decided again. A delivery a policy edit already
 * requeued keeps its newer attempt, and the answer still reaches the next decision as data.
 */
function settleAnsweredDelivery(ctx: ForgeLedgerContext, deliveryId: number): void {
  const delivery = ctx.db
    .prepare(`SELECT binding_id, decision_state, finished_at, policy_generation
    FROM webhook_deliveries WHERE id = ? AND host_id = ?`)
    .get(deliveryId, ctx.hostId)
  if (
    !delivery ||
    delivery.finished_at !== null ||
    rowText(delivery, 'decision_state') === 'cancelled'
  ) {
    return
  }
  const link = getProjectEventRepoLinkByBinding(ctx, rowText(delivery, 'binding_id'))
  // A disabled policy already finished this delivery through its trigger; only an unlinked one is left.
  if (!link) {
    ctx.db
      .prepare(
        `UPDATE webhook_deliveries SET decision_state = 'cancelled' WHERE id = ? AND host_id = ?`
      )
      .run(deliveryId, ctx.hostId)
    finishForgeWebhookDelivery(ctx, deliveryId, 'failed', 'missing-link')
    return
  }
  // A policy edit can requeue the delivery while the question stays open; that newer attempt keeps
  // its state, and the recorded answer reaches the next decision instead.
  const requeued = ctx.db
    .prepare(`UPDATE webhook_deliveries SET state = 'pending', decision_state = 'queued',
    parked_reason = NULL, attempts = 0, policy_generation = ?, last_error_code = NULL,
    next_attempt_at = NULL, decision_token = NULL, decision_started_at = NULL
    WHERE id = ? AND host_id = ? AND finished_at IS NULL AND state = 'parked'`)
    .run(rowNumber(delivery, 'policy_generation'), deliveryId, ctx.hostId)
  if (requeued.changes !== 1) {
    return
  }
  // The unique current-decision index leaves no room for the old decision beside the new attempt.
  ctx.db
    .prepare(`UPDATE project_event_decisions SET superseded = 1 WHERE delivery_id = ? AND host_id = ?
    AND superseded = 0`)
    .run(deliveryId, ctx.hostId)
}

/** One conditional UPDATE is the whole arbitration: a racing or repeated answer changes nothing. */
export function answerProjectEventQuestion(
  ctx: ForgeLedgerContext,
  input: { ownerHostId: string; questionId: number; answer: string }
): ProjectEventQuestionAnswerResult {
  if (input.ownerHostId !== ctx.hostId) {
    return { ok: false, reason: 'not-found' }
  }
  const answer = normalizedAnswer(input.answer)
  if (answer === null) {
    return { ok: false, reason: 'question-answer-invalid' }
  }
  return runForgeTransaction(ctx.db, (): ProjectEventQuestionAnswerResult => {
    const row = ctx.db
      .prepare(`SELECT id, delivery_id, item_id, question, subject_kind, subject_iid, subject_title,
      source, status, asked_at, answered_at
      FROM project_event_questions WHERE id = ? AND host_id = ? AND status = 'open'`)
      .get(input.questionId, ctx.hostId)
    if (!row) {
      return { ok: false, reason: 'not-found' }
    }
    const answeredAt = ctx.now()
    const update = ctx.db
      .prepare(`UPDATE project_event_questions SET status = 'answered', answer = ?, answered_at = ?
      WHERE id = ? AND host_id = ? AND status = 'open'`)
      .run(answer, answeredAt, input.questionId, ctx.hostId)
    if (update.changes !== 1) {
      return { ok: false, reason: 'not-found' }
    }
    settleAnsweredDelivery(ctx, rowNumber(row, 'delivery_id'))
    return {
      ok: true,
      question: {
        ...viewOf(row),
        status: 'answered',
        answeredAt
      }
    }
  })
}

export function listProjectEventQuestions(
  ctx: ForgeLedgerContext,
  input: { ownerHostId: string; status?: ProjectEventQuestionStatus }
): ProjectEventQuestionView[] {
  if (input.ownerHostId !== ctx.hostId) {
    return []
  }
  const rows = ctx.db
    .prepare(`SELECT id, item_id, question, subject_kind, subject_iid, subject_title, source,
    status, asked_at, answered_at
    FROM project_event_questions WHERE host_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC`)
    .all(ctx.hostId, input.status ?? null, input.status ?? null)
  return rows.map(viewOf)
}

export type ProjectEventQuestionAnswerPair = { id: number; question: string; answer: string }

export function projectEventQuestionAnswers(
  ctx: ForgeLedgerContext,
  deliveryId: number,
  generation: number
): ProjectEventQuestionAnswerPair[] {
  const rows = ctx.db
    .prepare(`SELECT q.id, q.question, q.answer FROM project_event_questions q
      JOIN project_event_decisions d ON d.id = q.decision_id AND d.host_id = q.host_id
      JOIN runs r ON r.id = d.run_id AND r.item_id = q.item_id
      JOIN items i ON i.id = q.item_id AND i.host_id = q.host_id
      JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
      WHERE q.host_id = ? AND q.delivery_id = ? AND q.status = 'answered'
        AND q.answer IS NOT NULL AND d.action = 'ask_user' AND d.delivery_id = q.delivery_id
        AND d.policy_generation = ? AND r.policy_generation = ? AND r.state = 'succeeded'
        AND r.context_digest = head.version_token AND r.analysis_kind = i.kind
      ORDER BY q.id ASC LIMIT ?`)
    .all(ctx.hostId, deliveryId, generation, generation, MAX_CONTEXT_ANSWERS + 1)
  if (rows.length > MAX_CONTEXT_ANSWERS) {
    throw new Error('project_event_answers_too_large')
  }
  return rows.map((row) => {
    const question = rowText(row, 'question')
    const answer = rowText(row, 'answer')
    if (
      !question.trim() ||
      !answer.trim() ||
      !question.isWellFormed() ||
      !answer.isWellFormed() ||
      Buffer.byteLength(question, 'utf8') > 4000 ||
      Buffer.byteLength(answer, 'utf8') > FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES ||
      // eslint-disable-next-line no-control-regex -- an answer must never carry control characters
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(question + answer)
    ) {
      throw new Error('project_event_answers_too_large')
    }
    return { id: rowNumber(row, 'id'), question, answer }
  })
}
