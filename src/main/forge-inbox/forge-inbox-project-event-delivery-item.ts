import type { ForgeNotificationReason } from '../../shared/forge-inbox-notification-subject'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import { projectEventActionFacts } from './forge-inbox-project-event-action-facts'
import { projectEventNotificationCategory } from './forge-inbox-project-event-notification'
import {
  projectEventSubject,
  resolveProjectEventSubject,
  type ProjectEventSubject,
  type ProjectEventSubjectRefusal,
  PROJECT_ITEM_IID
} from './forge-inbox-project-event-subject'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import { isRecord, rowNumber, rowText } from './forge-inbox-rows'
import { PROJECT_EVENT_REVISION_PREFIX } from './forge-inbox-project-event-revision'
import { FORGE_PROVISIONAL_REVISION_PREFIX, type ForgeItemKind } from './forge-inbox-types'

export type ProjectEventDeliveryItem =
  | {
      ok: true
      itemId: number
      subject: ProjectEventSubject
      /** Reported facts an action may branch on; never the raw body. */
      facts: Record<string, unknown>
      notificationCategory: ForgeNotificationReason | null
    }
  | { ok: false; reason: ProjectEventSubjectRefusal | 'not-found' }

/**
 * Records the delivery's event on the item it is about, in the caller's write transaction. A project
 * item has no GitLab head to read back, so each distinct event is its own non-provisional revision.
 */
export function ingestProjectEventDeliveryItem(
  ctx: ForgeLedgerContext,
  input: {
    deliveryId: number
    bindingId: string
    notify: boolean
    only?: ForgeItemKind
    allowUnknown?: boolean
  }
): ProjectEventDeliveryItem {
  const delivery = ctx.db
    .prepare(
      `SELECT dedupe_key, event_kind, project_id, body FROM webhook_deliveries
      WHERE id = ? AND host_id = ?`
    )
    .get(input.deliveryId, ctx.hostId)
  if (!delivery) {
    return { ok: false, reason: 'not-found' }
  }
  const binding = ctx.db
    .prepare(
      `SELECT gitlab_host, gitlab_path, gitlab_project_id FROM project_bindings WHERE binding_id = ?`
    )
    .get(input.bindingId)
  if (
    !binding ||
    typeof binding.gitlab_project_id !== 'number' ||
    !Number.isSafeInteger(binding.gitlab_project_id) ||
    binding.gitlab_project_id <= 0 ||
    typeof binding.gitlab_host !== 'string' ||
    !binding.gitlab_host
  ) {
    return { ok: false, reason: 'item-identity-missing' }
  }
  let facts: Record<string, unknown>
  try {
    facts = projectEventDecisionFacts(delivery.body)
  } catch {
    return { ok: false, reason: 'invalid-input' }
  }
  if (!(delivery.body instanceof Uint8Array)) {
    return { ok: false, reason: 'invalid-input' }
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(delivery.body))
  } catch {
    return { ok: false, reason: 'invalid-input' }
  }
  if (
    !isRecord(payload) ||
    ('project' in payload && (!isRecord(payload.project) || !('id' in payload.project))) ||
    ('object_attributes' in payload && !isRecord(payload.object_attributes))
  ) {
    return { ok: false, reason: 'invalid-input' }
  }
  if (
    isRecord(payload.project) &&
    'path_with_namespace' in payload.project &&
    payload.project.path_with_namespace !== binding.gitlab_path
  ) {
    return { ok: false, reason: 'event-project-mismatch' }
  }
  const resolved = resolveProjectEventSubject(
    delivery.body,
    binding.gitlab_project_id,
    input.deliveryId,
    input.allowUnknown ? rowText(delivery, 'dedupe_key') : undefined
  )
  if (!resolved.ok) {
    return { ok: false, reason: resolved.code }
  }
  const { subject } = resolved
  if (input.only !== undefined && subject.kind !== input.only) {
    return { ok: false, reason: 'not-found' }
  }
  const instanceId = `${BINDING_INSTANCE_PREFIX}${binding.gitlab_host}`
  const projectId = rowText(delivery, 'project_id')
  const dedupeKey = rowText(delivery, 'dedupe_key')
  const actionFacts = projectEventActionFacts(delivery.body)
  const notificationCategory = input.notify ? projectEventNotificationCategory(actionFacts) : null
  // Why: a pipeline linked to its merge request reports the pipeline's status, not the request's.
  const reportsSubject = subject.trigger.kind !== 'pipeline' || subject.kind === 'pipeline'
  // The notification producer reads only the category; the reported facts are what names the trigger.
  const eventPayload = {
    ...facts,
    ...(notificationCategory === null ? {} : { category: notificationCategory }),
    facts: reportedFacts(actionFacts)
  }
  const result = ingestForgeEventInTransaction(ctx, {
    hostId: ctx.hostId,
    // The configured GitLab origin is the instance identity for this flow.
    instanceId,
    projectId,
    kind: subject.kind,
    iid: subject.iid,
    ...(subject.kind === 'project' ? { itemIdSuffix: subject.iid } : {}),
    dedupeKey,
    eventKind: rowText(delivery, 'event_kind'),
    ...revisionOf(subject, input.deliveryId, facts, dedupeKey),
    payload: eventPayload,
    title: eventTitle(subject.kind, facts, rowText(binding, 'gitlab_path')),
    ...(reportsSubject && typeof facts.state === 'string' ? { itemState: facts.state } : {})
  })
  const itemId = result.duplicate ? linkedItemId(ctx, result.eventId) : result.itemId
  // A distinct event always opens its own item; one that merged into an existing item predates this.
  if (result.duplicate === false && result.createdItemId !== null) {
    closeEmptyProjectItem(ctx, instanceId, projectId)
  }
  return { ok: true, itemId, subject, facts: actionFacts, notificationCategory }
}

/**
 * What happened, in words a reader can tell apart from the last time: the action for merge requests,
 * issues, notes and releases; the status for pipelines, deployments and tag pushes; the head ref for
 * a push. Only short reported fields are kept, never titles or note bodies.
 */
function reportedFacts(facts: Record<string, unknown>): Record<string, string> {
  const read = (key: string): string | undefined => {
    const value = facts[key]
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FACT_CHARS
      ? value
      : undefined
  }
  const kind = read('kind')
  const action = read('action')
  const status = read('status')
  const state = read('state')
  const mergeStatus = read('mergeStatus')
  const ref = read('ref')
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(action === undefined ? {} : { action }),
    ...(status === undefined ? {} : { status }),
    ...(state === undefined ? {} : { state }),
    ...(mergeStatus === undefined ? {} : { mergeStatus }),
    ...(ref === undefined ? {} : { ref }),
    ...(typeof facts.hasConflicts === 'boolean' ? { hasConflicts: String(facts.hasConflicts) } : {})
  }
}

function eventTitle(
  kind: ForgeItemKind,
  facts: Record<string, unknown>,
  gitlabPath: string
): string {
  if (kind === 'project') {
    return gitlabPath
  }
  return typeof facts.title === 'string' ? facts.title : ''
}

/** An item exists only for the events recorded on it, so an item with none keeps nothing. */
function closeEmptyProjectItem(
  ctx: ForgeLedgerContext,
  instanceId: string,
  projectId: string
): void {
  ctx.db
    .prepare(
      `DELETE FROM items WHERE host_id = ? AND instance_id = ? AND project_id = ? AND kind = 'project'
       AND iid = ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.item_id = items.id)`
    )
    .run(ctx.hostId, instanceId, projectId, PROJECT_ITEM_IID)
}

const MAX_FACT_CHARS = 64

function revisionOf(
  subject: ProjectEventSubject,
  deliveryId: number,
  facts: Record<string, unknown>,
  dedupeKey: string
): { versionToken: string; sourceOrder: number } {
  if (subject.fingerprint === undefined) {
    // Reported, not observed: this revision is provisional until an authenticated read of the
    // current head replaces it, so it must never be treated as the newest commit.
    return {
      versionToken: `${FORGE_PROVISIONAL_REVISION_PREFIX}${typeof facts.sha === 'string' ? facts.sha : dedupeKey}`,
      sourceOrder: 0
    }
  }
  return {
    versionToken: `${PROJECT_EVENT_REVISION_PREFIX}${subject.fingerprint}`,
    // Admission order, not link order: a delivery decided late must not take the head from a newer one.
    sourceOrder: deliveryId
  }
}

function linkedItemId(ctx: ForgeLedgerContext, eventId: number): number {
  const row = ctx.db.prepare('SELECT item_id FROM events WHERE id = ?').get(eventId)
  if (!row) {
    throw new Error('a linked project event action should have its event')
  }
  return rowNumber(row, 'item_id')
}

/** Queued actions must see newer project heads even while execution capacity keeps them waiting. */
export function recordProjectEventItem(
  ctx: ForgeLedgerContext,
  input: {
    deliveryId: number
    bindingId: string
    decisionId: number
    notify: boolean
    allowUnknown: boolean
  }
): ProjectEventSubjectRefusal | null {
  const linked = ingestProjectEventDeliveryItem(ctx, {
    deliveryId: input.deliveryId,
    bindingId: input.bindingId,
    notify: input.notify,
    only: 'project',
    allowUnknown: input.allowUnknown
  })
  if (linked.ok) {
    ctx.db
      .prepare('UPDATE project_event_decisions SET item_id = ? WHERE id = ?')
      .run(linked.itemId, input.decisionId)
    return null
  }
  return linked.reason === 'not-found' ? null : linked.reason
}

/**
 * Points a decision at the item its delivery already names, without creating one: a queued action
 * must be visible on that item's timeline before it is ever claimed.
 */
export function linkExistingProjectEventItem(
  ctx: ForgeLedgerContext,
  input: { deliveryId: number; bindingId: string; decisionId: number }
): void {
  const delivery = ctx.db
    .prepare('SELECT project_id, body FROM webhook_deliveries WHERE id = ? AND host_id = ?')
    .get(input.deliveryId, ctx.hostId)
  const binding = ctx.db
    .prepare('SELECT gitlab_host, gitlab_project_id FROM project_bindings WHERE binding_id = ?')
    .get(input.bindingId)
  if (!delivery || !binding || typeof binding.gitlab_project_id !== 'number') {
    return
  }
  const subject = projectEventSubject(delivery.body, binding.gitlab_project_id, input.deliveryId)
  if (!subject) {
    return
  }
  const item = ctx.db
    .prepare(`SELECT id FROM items WHERE host_id = ? AND instance_id = ? AND project_id = ?
      AND kind = ? AND iid = ?`)
    .get(
      ctx.hostId,
      `${BINDING_INSTANCE_PREFIX}${rowText(binding, 'gitlab_host')}`,
      rowText(delivery, 'project_id'),
      subject.kind,
      subject.iid
    )
  if (item === undefined) {
    return
  }
  const itemId = rowNumber(item, 'id')
  // Why: a project item holds one trigger, so the decision must own the item's own event, not another's.
  const owns =
    subject.kind !== 'project' ||
    ctx.db
      .prepare(
        `SELECT 1 FROM events WHERE item_id = ? AND version_token = (
       SELECT r.version_token FROM items i JOIN item_revisions r ON r.item_id = i.id
        AND r.revision = i.current_revision WHERE i.id = ?) LIMIT 1`
      )
      .get(itemId, itemId) !== undefined
  if (!owns) {
    return
  }
  ctx.db
    .prepare('UPDATE project_event_decisions SET item_id = ? WHERE id = ? AND item_id IS NULL')
    .run(itemId, input.decisionId)
}
