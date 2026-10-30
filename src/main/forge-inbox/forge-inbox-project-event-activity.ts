import {
  clampProjectEventActivityLimit,
  PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT,
  type ProjectEventActivityEntry,
  type ProjectEventActivityOutcome,
  type ProjectEventActivityView
} from '../../shared/forge-inbox-project-event-activity'
import { FORGE_ITEM_KINDS, type ForgeItemKind } from './forge-inbox-types'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'
import { forgeDeliveryErrorSource } from './forge-inbox-error-source'
import { rowNumber } from './forge-inbox-rows'
import type { ForgeLedgerContext } from './forge-inbox-context'
import type { SqliteRow } from '../sqlite/sqlite-statement'

const ACTIVITY_COLUMNS = `
  w.id AS delivery_id, w.admitted_at, COALESCE(w.finished_at, w.admitted_at) AS finished_at,
  w.decision_state, w.state AS delivery_state,
  w.parked_reason, w.last_error_code AS delivery_error, w.body,
  d.action, d.action_state, d.last_error_code AS decision_error,
  i.kind AS item_kind, i.iid AS item_iid, i.title AS item_title`

const ACTIVITY_FROM = `
  FROM webhook_deliveries w
  JOIN project_event_repo_links l ON l.host_id = w.host_id AND l.binding_id = w.binding_id
  LEFT JOIN project_event_decisions d ON d.id = (
    SELECT id FROM project_event_decisions WHERE delivery_id = w.id AND superseded = 0
    ORDER BY id DESC LIMIT 1)
  LEFT JOIN items i ON i.id = d.item_id`

const ACTIVITY_SCOPE = 'w.host_id = ? AND l.repo_id = ? AND w.binding_id IS NOT NULL'

const TITLE_MAX_CHARS = 512

export type ProjectEventActivityOutcomeInput = {
  deliveryState: string | null
  parkedReason: string | null
  decisionState: string | null
  action: string | null
  actionState: string | null
}

/** Exhaustive over the delivery states; an uncovered combination stays unknown, never failed. */
export function projectEventActivityOutcome(
  input: ProjectEventActivityOutcomeInput
): ProjectEventActivityOutcome {
  switch (input.deliveryState) {
    case null:
      return 'unknown'
    case 'failed':
      return 'failed'
    case 'needs-auth':
      return 'needs-user'
    case 'done':
      if (input.action === 'record_only') {
        return 'recorded'
      }
      if (input.action === 'notify') {
        return 'notified'
      }
      return 'done'
    case 'parked':
      if (input.parkedReason === 'awaiting-user') {
        return 'needs-user'
      }
      if (input.parkedReason === 'awaiting-policy' || input.actionState === 'awaiting-event') {
        return 'waiting'
      }
      return 'unknown'
    case 'pending':
      if (
        input.decisionState === 'queued' ||
        input.decisionState === 'processing' ||
        input.decisionState === 'retry' ||
        input.decisionState === 'decided' ||
        input.actionState === 'queued' ||
        input.actionState === 'processing'
      ) {
        return 'processing'
      }
      return 'unknown'
    default:
      return 'unknown'
  }
}

function optionalNumber(row: SqliteRow, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : rowNumber(row, column)
}

function optionalText(row: SqliteRow, column: string): string | null {
  return typeof row[column] === 'string' ? row[column] : null
}

function forgeItemKind(value: unknown): ForgeItemKind | 'unknown' {
  return typeof value === 'string'
    ? (FORGE_ITEM_KINDS.find((kind) => kind === value) ?? 'unknown')
    : 'unknown'
}

function bodyFacts(body: unknown): Record<string, unknown> {
  try {
    return projectEventDecisionFacts(body)
  } catch {
    return {}
  }
}

function activityEntry(row: SqliteRow): ProjectEventActivityEntry {
  const itemKind = optionalText(row, 'item_kind')
  const facts = itemKind === null ? bodyFacts(row.body) : {}
  const iid = optionalNumber(row, 'item_iid') ?? (typeof facts.iid === 'number' ? facts.iid : null)
  const title =
    optionalText(row, 'item_title') ?? (typeof facts.title === 'string' ? facts.title : '')
  const deliveryState = optionalText(row, 'delivery_state')
  const parkedReason = optionalText(row, 'parked_reason')
  const decisionState = optionalText(row, 'decision_state')
  const action = optionalText(row, 'action')
  const actionState = optionalText(row, 'action_state')
  return {
    id: rowNumber(row, 'delivery_id'),
    kind: itemKind === null ? forgeItemKind(facts.kind) : forgeItemKind(itemKind),
    iid,
    title: title.slice(0, TITLE_MAX_CHARS),
    occurredAt: rowNumber(row, 'admitted_at'),
    finishedAt: rowNumber(row, 'finished_at'),
    outcome: projectEventActivityOutcome({
      deliveryState,
      parkedReason,
      decisionState,
      action,
      actionState
    }),
    errorCode: optionalText(row, 'delivery_error') ?? optionalText(row, 'decision_error'),
    errorSource: forgeDeliveryErrorSource({
      decisionState,
      action,
      deliveryError: optionalText(row, 'delivery_error'),
      actionError: optionalText(row, 'decision_error')
    })
  }
}

export function readProjectEventActivity(
  ctx: ForgeLedgerContext,
  input: { repoId: string; limit?: number }
): ProjectEventActivityView {
  const limit =
    input.limit === undefined
      ? PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT
      : clampProjectEventActivityLimit(input.limit)
  const events = ctx.db
    .prepare(
      `SELECT ${ACTIVITY_COLUMNS} ${ACTIVITY_FROM} WHERE ${ACTIVITY_SCOPE}
       ORDER BY w.admitted_at DESC, w.id DESC LIMIT ?`
    )
    .all(ctx.hostId, input.repoId, limit)
    .map(activityEntry)
  const last = ctx.db
    .prepare(
      `SELECT ${ACTIVITY_COLUMNS} ${ACTIVITY_FROM}
       WHERE ${ACTIVITY_SCOPE} AND w.state IN ('done', 'failed')
       ORDER BY COALESCE(w.finished_at, w.admitted_at) DESC, w.id DESC LIMIT 1`
    )
    .get(ctx.hostId, input.repoId)
  return { events, lastProcessed: last ? activityEntry(last) : null }
}
