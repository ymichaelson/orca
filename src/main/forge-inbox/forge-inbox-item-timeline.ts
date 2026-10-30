import {
  FORGE_ITEM_TIMELINE_KINDS,
  type ForgeItemTimelineEntry,
  type ForgeItemTimelineKind
} from '../../shared/forge-inbox-item-timeline'
import { FORGE_RUN_STATES, type ForgeRunState } from '../../shared/forge-inbox-types'
import {
  PROJECT_EVENT_DECISION_ACTIONS,
  type ProjectEventDecisionAction
} from '../../shared/project-event-decision'
import {
  FORGE_PROJECT_EVENT_QUESTION_SOURCES,
  projectEventAnswerText,
  type ProjectEventQuestionSource,
  type ProjectEventQuestionSubject
} from '../../shared/forge-inbox-project-event-question'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { readDispatchConfirmationViews } from './forge-inbox-dispatch-confirmation-view'
import { summarizeForgeEventPayload } from './forge-inbox-event-summary'
import { forgeActionErrorSource } from './forge-inbox-error-source'
import { rowNumber } from './forge-inbox-rows'
import type { SqliteRow } from '../sqlite/sqlite-statement'

const TIMELINE_DEFAULT_LIMIT = 50
const TIMELINE_MAX_LIMIT = 100

/** Every kind shares the same columns so one read can order them together; decisions and questions are scanned by item_id. */
function timelineSql(): string {
  return `
SELECT * FROM (
  SELECT 'event' AS kind, e.id AS row_id, e.received_at AS at, e.event_kind AS label,
    NULL AS detail, NULL AS error_code, e.payload_json AS payload, NULL AS question_id,
    NULL AS subject_kind, NULL AS subject_iid, NULL AS subject_title, NULL AS stored_question,
    NULL AS superseded, NULL AS answer_text, NULL AS source
  FROM events e WHERE e.item_id = ?
  UNION ALL
  SELECT 'decision', d.id, d.decided_at, d.action, d.action_state, d.last_error_code, NULL,
    NULL, NULL, NULL, NULL, NULL, d.superseded, NULL, NULL
  FROM project_event_decisions d
  WHERE d.item_id = ? AND d.host_id = ?
  UNION ALL
  SELECT 'run', r.id, r.updated_at, r.state, r.reason, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM runs r WHERE r.item_id = ?
  UNION ALL
  SELECT 'question', q.id, q.asked_at, q.status, NULL, NULL, NULL, q.id,
    q.subject_kind, q.subject_iid, q.subject_title, q.question, NULL, NULL, q.source
  FROM project_event_questions q WHERE q.item_id = ? AND q.host_id = ?
  UNION ALL
  SELECT 'answer', q.id, q.answered_at, 'answered', NULL, NULL, NULL, q.id,
    NULL, NULL, NULL, NULL, NULL, q.answer, NULL
  FROM project_event_questions q
  WHERE q.item_id = ? AND q.host_id = ? AND q.answered_at IS NOT NULL
)
ORDER BY at DESC, kind, row_id DESC LIMIT ?`
}

function text(row: SqliteRow, column: string): string | null {
  return typeof row[column] === 'string' ? row[column] : null
}

function questionSubject(row: SqliteRow): ProjectEventQuestionSubject | null {
  const kind = text(row, 'subject_kind')
  const title = text(row, 'subject_title')
  const iid = row['subject_iid']
  if (kind === null || title === null || typeof iid !== 'number' || !Number.isSafeInteger(iid)) {
    return null
  }
  return { kind, iid, title }
}

function questionSource(row: SqliteRow): ProjectEventQuestionSource | null {
  const source = row['source']
  return FORGE_PROJECT_EVENT_QUESTION_SOURCES.find((known) => known === source) ?? null
}

function timelineKind(value: string | null): ForgeItemTimelineKind | null {
  return value === null
    ? null
    : (FORGE_ITEM_TIMELINE_KINDS.find((candidate) => candidate === value) ?? null)
}

function runState(value: string | null): ForgeRunState | null {
  return value === null ? null : (FORGE_RUN_STATES.find((candidate) => candidate === value) ?? null)
}

function decisionAction(value: string | null): ProjectEventDecisionAction | null {
  return value === null
    ? null
    : (PROJECT_EVENT_DECISION_ACTIONS.find((candidate) => candidate === value) ?? null)
}

function entryOf(row: SqliteRow): ForgeItemTimelineEntry | null {
  const kind = timelineKind(text(row, 'kind'))
  if (kind === null) {
    return null
  }
  const at = rowNumber(row, 'at')
  const rowId = rowNumber(row, 'row_id')
  switch (kind) {
    case 'event':
      return {
        kind,
        id: `event:${rowId}`,
        at,
        eventKind: text(row, 'label') ?? '',
        summary: summarizeForgeEventPayload(text(row, 'payload') ?? '')
      }
    case 'decision': {
      const action = decisionAction(text(row, 'label'))
      const state = text(row, 'detail')
      if (action === null || state === null) {
        return null
      }
      return {
        kind,
        id: `decision:${rowId}`,
        at,
        action,
        state,
        errorCode: text(row, 'error_code'),
        errorSource: forgeActionErrorSource(action, text(row, 'error_code')),
        superseded: row['superseded'] === 1
      }
    }
    case 'run': {
      const state = runState(text(row, 'label'))
      if (state === null) {
        return null
      }
      return { kind, id: `run:${rowId}`, at, state, reason: text(row, 'detail') }
    }
    case 'question': {
      const source = questionSource(row)
      return {
        kind,
        id: `question:${rowId}`,
        at,
        questionId: rowNumber(row, 'question_id'),
        question: text(row, 'stored_question') ?? '',
        subject: questionSubject(row),
        ...(source === null ? {} : { source })
      }
    }
    case 'answer':
      return {
        kind,
        id: `answer:${rowId}`,
        at,
        questionId: rowNumber(row, 'question_id'),
        answer: projectEventAnswerText(text(row, 'answer_text') ?? '')
      }
  }
}

/** Host and item are checked once here, so a foreign item id can never leak another host's stream. */
export function readForgeItemTimeline(
  ctx: ForgeLedgerContext,
  itemId: number,
  limit = TIMELINE_DEFAULT_LIMIT
): ForgeItemTimelineEntry[] {
  const owned = ctx.db
    .prepare('SELECT 1 AS found FROM items WHERE id = ? AND host_id = ?')
    .get(itemId, ctx.hostId)
  if (!owned) {
    return []
  }
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : TIMELINE_DEFAULT_LIMIT
  const size = Math.min(Math.max(requested, 1), TIMELINE_MAX_LIMIT)
  const rows = ctx.db
    .prepare(timelineSql())
    .all(itemId, itemId, ctx.hostId, itemId, itemId, ctx.hostId, itemId, ctx.hostId, size)
  const confirmations = readDispatchConfirmationViews(
    ctx,
    rows.flatMap((row) => (text(row, 'kind') === 'run' ? [rowNumber(row, 'row_id')] : []))
  )
  return rows.flatMap((row) => {
    const entry = entryOf(row)
    if (entry === null) {
      return []
    }
    const confirmation =
      entry.kind === 'run' ? confirmations.get(rowNumber(row, 'row_id')) : undefined
    return [confirmation ? { ...entry, dispatchConfirmation: confirmation } : entry]
  })
}
