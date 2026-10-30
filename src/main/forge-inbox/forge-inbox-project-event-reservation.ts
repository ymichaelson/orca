import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { hasProjectEventDispatchCapacity } from './forge-inbox-project-event-dispatch-capacity'
import { createDispatchConfirmation } from './forge-inbox-dispatch-confirmation'
import { queueForgeItemRunOutcome } from './forge-inbox-ingest'
import { PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL } from './forge-inbox-project-event-delivery-head-join'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action-types'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'
import { PROJECT_EVENT_REVISION_PREFIX } from './forge-inbox-project-event-revision'
import { projectEventQuestionAnswers } from './forge-inbox-project-event-question-answer'
import type { ProjectEventQuestionAttempt } from './forge-inbox-project-event-question-task'
import { projectEventSubject, type ProjectEventSubject } from './forge-inbox-project-event-subject'
import { applyTransition, readForgeRun } from './forge-inbox-runs'
import { rowNumber, rowText } from './forge-inbox-rows'
import { parseProjectPush, type ProjectPushSummary } from './forge-inbox-project-event-push'
import {
  persistedProjectEventFacts,
  projectEventDecisionFacts
} from './forge-inbox-project-event-decision-facts'

export type ProjectEventReserved =
  | {
      kind: 'reserved'
      runId: number
      marker: string
      answers: ReturnType<typeof projectEventQuestionAnswers>
    }
  | { kind: 'queued' }
  | { kind: 'blocked'; code: string }

export type DispatchHead = {
  itemId: number
  bindingId: string
  gitlabHost: string
  gitlabProjectId: number
  versionToken: string
  kind: string
  iid: number
  title: string
  state: string | null
  sha: string | null
  ref: string | null
  projectPath: string
  gitlabPath: string
  trigger: ProjectEventSubject['trigger'] | null
  /** The event this delivery reported, when it still describes the current project head. */
  push: ProjectPushSummary | null
  reportedEvent: Record<string, unknown> | null
}

/** The item and its authenticated head, read through the delivery the decision was made for. */
export function projectEventDispatchHead(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim
): DispatchHead | null {
  const row = ctx.db
    .prepare(
      `SELECT i.id AS item_id, i.kind, i.iid, i.title, i.state, r.version_token,
         d.id AS delivery_event_id, e.id AS head_event_id, e.payload_json AS head_payload,
         b.binding_id, b.gitlab_host, b.project_path, b.gitlab_path, b.gitlab_project_id, w.body,
         CASE WHEN json_valid(e.payload_json)
           THEN json_extract(e.payload_json, '$.sha') END AS sha,
         CASE WHEN json_valid(e.payload_json)
           THEN json_extract(e.payload_json, '$.ref') END AS ref
       FROM webhook_deliveries w
       ${PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL}
       JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
       LEFT JOIN events e ON e.id = CASE WHEN i.kind = 'project' THEN (
         SELECT id FROM events WHERE item_id = i.id AND revision = i.current_revision
         ORDER BY source_order DESC, id DESC LIMIT 1) ELSE (
         SELECT MAX(id) FROM events WHERE item_id = i.id AND revision = i.current_revision) END
       WHERE w.id = ? AND w.host_id = ?`
    )
    .get(claim.deliveryId, ctx.hostId)
  if (!row) {
    return null
  }
  const subject = projectEventSubject(row.body, rowNumber(row, 'gitlab_project_id'))
  const kind = rowText(row, 'kind')
  const versionToken = rowText(row, 'version_token')
  const current = kind !== 'project' || row.delivery_event_id === row.head_event_id
  const persistedEvent =
    kind === 'project' && !current ? persistedProjectEventFacts(row.head_payload) : null
  return {
    itemId: rowNumber(row, 'item_id'),
    bindingId: rowText(row, 'binding_id'),
    gitlabHost: rowText(row, 'gitlab_host'),
    gitlabProjectId: rowNumber(row, 'gitlab_project_id'),
    versionToken,
    kind,
    iid: rowNumber(row, 'iid'),
    title: rowText(row, 'title'),
    state: rowText(row, 'state'),
    sha: typeof row.sha === 'string' ? row.sha : null,
    ref: kind === 'project' && !current && typeof row.ref === 'string' ? row.ref : null,
    projectPath: rowText(row, 'project_path'),
    gitlabPath: rowText(row, 'gitlab_path'),
    trigger: current
      ? (subject?.trigger ?? null)
      : persistedEvent && typeof persistedEvent.kind === 'string'
        ? { kind: persistedEvent.kind, id: null }
        : null,
    push:
      current && kind === 'project' && row.body instanceof Uint8Array
        ? parseProjectPush(row.body)
        : null,
    reportedEvent:
      current &&
      kind === 'project' &&
      (subject?.trigger.kind === 'release' || subject?.trigger.kind === 'deployment')
        ? projectEventDecisionFacts(row.body)
        : persistedEvent
  }
}

export function reserveProjectEventDispatch(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  head: DispatchHead,
  questionAttempt: ProjectEventQuestionAttempt = 'prepare'
): ProjectEventReserved | null {
  return runForgeTransaction(ctx.db, () => {
    const held = ctx.db
      .prepare(`SELECT 1 FROM project_event_decisions
      WHERE id = ? AND host_id = ? AND action_state = 'processing'
        AND action_token = ? AND superseded = 0`)
      .get(claim.decisionId, ctx.hostId, claim.token)
    if (!held) {
      return null
    }
    const currentHead = ctx.db
      .prepare(`SELECT r.version_token FROM items i
      JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
      WHERE i.id = ? AND i.host_id = ?`)
      .get(head.itemId, ctx.hostId)
    if (!currentHead || rowText(currentHead, 'version_token') !== head.versionToken) {
      return { kind: 'blocked', code: 'head-moved' }
    }
    if (head.kind === 'project') {
      const v2Prefix = `${PROJECT_EVENT_REVISION_PREFIX}v2:`
      const legacyRun = ctx.db
        .prepare(
          `SELECT 1 FROM runs WHERE item_id = ? AND context_digest LIKE ? AND context_digest NOT LIKE ? LIMIT 1`
        )
        .get(head.itemId, `${PROJECT_EVENT_REVISION_PREFIX}%`, `${v2Prefix}%`)
      const current = ctx.db
        .prepare(
          `SELECT r.version_token FROM items i JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision WHERE i.id = ?`
        )
        .get(head.itemId)
      if (!current || !rowText(current, 'version_token').startsWith(v2Prefix) || legacyRun) {
        return { kind: 'blocked', code: 'dispatch-unverifiable' }
      }
      if (rowText(current, 'version_token') !== head.versionToken) {
        return { kind: 'blocked', code: 'head-moved' }
      }
    }
    // Observation awaited: another drain may have taken the project's or host's last slot.
    if (!hasProjectEventDispatchCapacity(ctx, head.bindingId)) {
      return { kind: 'queued' }
    }
    const answers = projectEventQuestionAnswers(ctx, claim.deliveryId, claim.generation)
    const answer = answers[0]
    const scope =
      claim.action === 'ask_user'
        ? {
            purpose:
              questionAttempt === 'answer' ? ('question-task' as const) : ('question' as const),
            deliveryId: claim.deliveryId
          }
        : answer
          ? { purpose: 'answered' as const, questionId: answer.id }
          : null
    const queued = queueForgeItemRunOutcome(
      ctx,
      head.itemId,
      PROJECT_EVENT_DISPATCH_RUN_REASON,
      scope
    )
    if (queued.kind !== 'queued') {
      return {
        kind: 'blocked',
        code: queued.kind === 'claimed' ? 'already-dispatched' : 'provisional-head'
      }
    }
    const run = readForgeRun(ctx, queued.runId)
    if (!run || !applyTransition(ctx, run, { to: 'running' }).ok) {
      throw new Error('dispatch reservation could not start its run')
    }
    const marker = createDispatchConfirmation(ctx, {
      runId: run.id,
      bindingId: head.bindingId,
      gitlabHost: head.gitlabHost,
      gitlabProjectId: head.gitlabProjectId,
      itemKind: head.kind,
      itemIid: head.iid,
      expectedSha: head.sha
    })
    // The owed task replaces the preparation run this decision pointed at; the held token is the fence.
    const linked = ctx.db
      .prepare(`UPDATE project_event_decisions SET run_id = ?
      WHERE id = ? AND host_id = ? AND action_token = ? AND superseded = 0`)
      .run(run.id, claim.decisionId, ctx.hostId, claim.token)
    if (linked.changes !== 1) {
      throw new Error('dispatch decision could not bind its run')
    }
    if (claim.action === 'ask_user') {
      const parked = ctx.db
        .prepare(`UPDATE webhook_deliveries SET state = 'parked',
        parked_reason = 'preparing-question', next_attempt_at = NULL
        WHERE id = ? AND host_id = ? AND finished_at IS NULL
          AND (state = 'pending' OR (state = 'parked' AND parked_reason = 'preparing-question'))`)
        .run(claim.deliveryId, ctx.hostId)
      if (parked.changes !== 1) {
        throw new Error('question preparation could not park its delivery')
      }
      ctx.db
        .prepare(`UPDATE project_event_decisions SET action_state = 'blocked',
        action_token = NULL, last_error_code = 'preparing-question' WHERE id = ?`)
        .run(claim.decisionId)
    }
    return { kind: 'reserved', runId: run.id, marker, answers }
  })
}
