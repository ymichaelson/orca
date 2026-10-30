import {
  FORGE_NOTIFICATION_REASONS,
  type ForgeInboxNotificationSubject,
  type ForgeNotificationReason
} from '../../shared/forge-inbox-notification-subject'
import type { ForgeChange } from '../../shared/forge-inbox-types'
import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { summarizeForgeEventPayload } from './forge-inbox-event-summary'
import {
  DISPATCH_CHANGE_PREFIX,
  readDispatchConfirmation,
  type DispatchConfirmationState
} from './forge-inbox-dispatch-confirmation'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-action-dispatch'
import { PROJECT_EVENT_REVISION_PREFIX } from './forge-inbox-project-event-revision'
import { rowNumber, rowText } from './forge-inbox-rows'

const DISPATCH_VERDICT_STATES: readonly DispatchConfirmationState[] = [
  'confirmed',
  'contradicted',
  'unconfirmable',
  'no-claim'
]

export type ForgeNotification = ForgeInboxNotificationSubject & { seq: number }

type ItemFacts = {
  instanceId: string
  projectId: string
  currentRevision: number
}

/** Higher wins when one item has several candidates in a claim; ties go to the later change. */
const REASON_PRIORITY: Partial<Record<ForgeNotificationReason, number>> = {
  'proposal-pending': 3,
  'run-failed': 2,
  'run-succeeded': 1
}

export function forgeNotificationPriority(reason: ForgeNotificationReason): number {
  return REASON_PRIORITY[reason] ?? 0
}

export function createForgeCandidateReader(ctx: ForgeLedgerContext) {
  const enabledProjects = new Set(
    readForgeConfigState(ctx).config.instances.flatMap((instance) =>
      instance.projects
        .filter((project) => project.enabled)
        .map((project) => `${instance.id}\u0000${project.projectId}`)
    )
  )
  // Binding items have no entry in the retired config; the same key shape lets both gates agree.
  const enabledBindings = new Set(
    ctx.db
      .prepare(
        `SELECT b.gitlab_host, b.gitlab_path FROM project_bindings b
         JOIN project_event_repo_links l ON l.binding_id = b.binding_id AND l.host_id = ?
         JOIN project_event_policies p ON p.host_id = l.host_id AND p.repo_id = l.repo_id
         WHERE json_extract(p.policy_json, '$.enabled')`
      )
      .all(ctx.hostId)
      .map((row) => `gitlab:${rowText(row, 'gitlab_host')}\u0000${rowText(row, 'gitlab_path')}`)
  )
  const items = new Map<number, ItemFacts | null>()

  function itemFacts(itemId: number): ItemFacts | null {
    if (items.has(itemId)) {
      return items.get(itemId) ?? null
    }
    const row = ctx.db
      .prepare(
        `SELECT i.instance_id, i.project_id, i.current_revision
         FROM items i WHERE i.id = ? AND i.host_id = ?`
      )
      .get(itemId, ctx.hostId)
    const facts =
      row === undefined
        ? null
        : {
            instanceId: rowText(row, 'instance_id'),
            projectId: rowText(row, 'project_id'),
            currentRevision: rowNumber(row, 'current_revision')
          }
    items.set(itemId, facts)
    return facts
  }

  function subjectFor(
    change: ForgeChange,
    reason: ForgeNotificationReason,
    entity: Pick<ForgeInboxNotificationSubject, 'eventId' | 'runId' | 'proposalId' | 'trigger'>
  ): ForgeNotification | null {
    const facts = itemFacts(change.itemId)
    const projectKey = facts ? `${facts.instanceId}\u0000${facts.projectId}` : ''
    if (!facts || (!enabledProjects.has(projectKey) && !enabledBindings.has(projectKey))) {
      return null
    }
    return {
      ownerId: ctx.hostId,
      instanceId: facts.instanceId,
      itemId: change.itemId,
      reason,
      seq: change.seq,
      ...entity
    }
  }

  function eventCandidate(change: ForgeChange): ForgeNotification | null {
    const row = ctx.db
      .prepare('SELECT item_id, version_token, source_order, payload_json FROM events WHERE id = ?')
      .get(change.entityId)
    if (!row) {
      return null
    }
    const summary = summarizeForgeEventPayload(rowText(row, 'payload_json'))
    const category = FORGE_NOTIFICATION_REASONS.find((reason) => reason === summary.category)
    if (!category || summary.passive) {
      return null
    }
    // A reported revision never moves the head: a later reported or categorized event is newer, and
    // a category-less observation is a read, not a change. `IS` stays false when `source` is absent.
    const later = ctx.db
      .prepare(
        `SELECT 1 AS found FROM events
         WHERE item_id = ? AND (source_order > ? OR (source_order = ? AND id > ?))
           AND CASE WHEN json_valid(payload_json)
             THEN NOT (version_token = ? AND json_extract(payload_json, '$.category') = ?)
               AND NOT (json_extract(payload_json, '$.source') IS 'observed'
                 AND json_extract(payload_json, '$.category') IS NULL)
             ELSE 1 END
         LIMIT 1`
      )
      .get(
        rowNumber(row, 'item_id'),
        rowNumber(row, 'source_order'),
        rowNumber(row, 'source_order'),
        change.entityId,
        rowText(row, 'version_token'),
        category
      )
    if (later) {
      return null
    }
    const earlier = ctx.db
      .prepare(
        `SELECT 1 AS found FROM events
         WHERE item_id = ? AND id < ? AND version_token = ?
           AND CASE WHEN json_valid(payload_json) THEN
             json_extract(payload_json, '$.category') = ?
             AND COALESCE(json_extract(payload_json, '$.passive'), 0) = 0 END
         LIMIT 1`
      )
      .get(rowNumber(row, 'item_id'), change.entityId, rowText(row, 'version_token'), category)
    if (earlier) {
      return null
    }
    const version = rowText(row, 'version_token')
    return subjectFor(change, category, {
      eventId: change.entityId,
      ...(category === 'project-event' && version.startsWith(PROJECT_EVENT_REVISION_PREFIX)
        ? { trigger: version.slice(PROJECT_EVENT_REVISION_PREFIX.length) }
        : {})
    })
  }

  function currentRunCandidate(change: ForgeChange): ForgeNotification | null {
    const row = ctx.db
      .prepare('SELECT state, reason, revision, policy_generation FROM runs WHERE id = ?')
      .get(change.entityId)
    const facts = itemFacts(change.itemId)
    if (
      !row ||
      !facts ||
      rowNumber(row, 'revision') !== facts.currentRevision ||
      rowNumber(row, 'policy_generation') !== policyGenerationOfItem(ctx, change.itemId)
    ) {
      return null
    }
    const runState = rowText(row, 'state')
    const confirmation = readDispatchConfirmation(ctx, change.entityId)?.state
    const verdict = dispatchVerdictOf(change.change)
    if (verdict !== null) {
      return confirmation === verdict ? dispatchVerdictCandidate(change, verdict, runState) : null
    }
    if (change.change === 'failed' && runState === 'failed') {
      return subjectFor(change, 'run-failed', { runId: change.entityId })
    }
    // A finished turn says nothing about what the agent did on GitLab; a dispatch's verdict speaks for it.
    if (
      change.change === 'succeeded' &&
      runState === 'succeeded' &&
      rowText(row, 'reason') !== PROJECT_EVENT_DISPATCH_RUN_REASON &&
      confirmation === undefined
    ) {
      return subjectFor(change, 'run-succeeded', { runId: change.entityId })
    }
    return null
  }

  function dispatchVerdictCandidate(
    change: ForgeChange,
    verdict: DispatchConfirmationState,
    runState: string
  ): ForgeNotification | null {
    if (verdict === 'contradicted' || verdict === 'unconfirmable') {
      // A failed turn already raised its own failure alert, so the verdict adds nothing but a second one.
      return runState === 'failed'
        ? null
        : subjectFor(change, 'project-event', { runId: change.entityId })
    }
    return (verdict === 'confirmed' || verdict === 'no-claim') && runState === 'succeeded'
      ? subjectFor(change, 'run-succeeded', { runId: change.entityId })
      : null
  }

  function currentProposalCandidate(change: ForgeChange): ForgeNotification | null {
    const row = ctx.db
      .prepare('SELECT status, revision, policy_generation FROM proposals WHERE id = ?')
      .get(change.entityId)
    const facts = itemFacts(change.itemId)
    if (
      change.change !== 'pending' ||
      !row ||
      !facts ||
      rowText(row, 'status') !== 'pending' ||
      rowNumber(row, 'revision') !== facts.currentRevision ||
      rowNumber(row, 'policy_generation') !== policyGenerationOfItem(ctx, change.itemId)
    ) {
      return null
    }
    return subjectFor(change, 'proposal-pending', { proposalId: change.entityId })
  }

  return {
    candidateFor(change: ForgeChange): ForgeNotification | null {
      switch (change.entity) {
        case 'event':
          return eventCandidate(change)
        case 'run':
          return currentRunCandidate(change)
        case 'proposal':
          return currentProposalCandidate(change)
        case 'receipt':
          return null
      }
    }
  }
}

function dispatchVerdictOf(change: string): DispatchConfirmationState | null {
  return change.startsWith(DISPATCH_CHANGE_PREFIX)
    ? (DISPATCH_VERDICT_STATES.find(
        (state) => state === change.slice(DISPATCH_CHANGE_PREFIX.length)
      ) ?? null)
    : null
}

/** The change a claimed run notification was raised from, read back from the run's current verdict. */
function runChangeOf(ctx: ForgeLedgerContext, notification: ForgeNotification): string {
  const confirmation =
    notification.runId === undefined
      ? undefined
      : readDispatchConfirmation(ctx, notification.runId)?.state
  if (notification.reason === 'run-failed') {
    return 'failed'
  }
  if (notification.reason === 'run-succeeded' && confirmation === undefined) {
    return 'succeeded'
  }
  const isRunReason =
    notification.reason === 'run-succeeded' || notification.reason === 'project-event'
  return isRunReason && confirmation !== undefined ? `${DISPATCH_CHANGE_PREFIX}${confirmation}` : ''
}

/** Re-evaluates a claimed notification against current state, for callbacks that ran in between. */
export function isForgeNotificationCurrent(
  ctx: ForgeLedgerContext,
  notification: ForgeNotification
): boolean {
  const base = { seq: notification.seq, itemId: notification.itemId, createdAt: 0 }
  const reader = createForgeCandidateReader(ctx)
  if (notification.proposalId !== undefined) {
    return (
      reader.candidateFor({
        ...base,
        entity: 'proposal',
        entityId: notification.proposalId,
        change: 'pending'
      }) !== null
    )
  }
  if (notification.runId !== undefined) {
    return (
      reader.candidateFor({
        ...base,
        entity: 'run',
        entityId: notification.runId,
        change: runChangeOf(ctx, notification)
      }) !== null
    )
  }
  return (
    notification.eventId !== undefined &&
    reader.candidateFor({
      ...base,
      entity: 'event',
      entityId: notification.eventId,
      change: ''
    }) !== null
  )
}
