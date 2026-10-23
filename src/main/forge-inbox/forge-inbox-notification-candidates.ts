import {
  FORGE_NOTIFICATION_REASONS,
  type ForgeInboxNotificationSubject,
  type ForgeNotificationReason
} from '../../shared/forge-inbox-notification-subject'
import type { ForgeChange } from '../../shared/forge-inbox-types'
import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { summarizeForgeEventPayload } from './forge-inbox-event-summary'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { rowNumber, rowText } from './forge-inbox-rows'

export type ForgeNotification = ForgeInboxNotificationSubject & { seq: number }

type ItemFacts = {
  instanceId: string
  projectId: string
  currentRevision: number
  currentVersionToken: string | null
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
  const items = new Map<number, ItemFacts | null>()

  function itemFacts(itemId: number): ItemFacts | null {
    if (items.has(itemId)) {
      return items.get(itemId) ?? null
    }
    const row = ctx.db
      .prepare(
        `SELECT i.instance_id, i.project_id, i.current_revision,
           (SELECT r.version_token FROM item_revisions r
            WHERE r.item_id = i.id AND r.revision = i.current_revision) AS version_token
         FROM items i WHERE i.id = ? AND i.host_id = ?`
      )
      .get(itemId, ctx.hostId)
    const facts =
      row === undefined
        ? null
        : {
            instanceId: rowText(row, 'instance_id'),
            projectId: rowText(row, 'project_id'),
            currentRevision: rowNumber(row, 'current_revision'),
            currentVersionToken: typeof row.version_token === 'string' ? row.version_token : null
          }
    items.set(itemId, facts)
    return facts
  }

  function subjectFor(
    change: ForgeChange,
    reason: ForgeNotificationReason,
    entity: Pick<ForgeInboxNotificationSubject, 'eventId' | 'runId' | 'proposalId'>
  ): ForgeNotification | null {
    const facts = itemFacts(change.itemId)
    if (!facts || !enabledProjects.has(`${facts.instanceId}\u0000${facts.projectId}`)) {
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
      .prepare('SELECT item_id, version_token, payload_json FROM events WHERE id = ?')
      .get(change.entityId)
    if (!row) {
      return null
    }
    const summary = summarizeForgeEventPayload(rowText(row, 'payload_json'))
    const category = FORGE_NOTIFICATION_REASONS.find((reason) => reason === summary.category)
    if (!category || summary.passive) {
      return null
    }
    if (rowText(row, 'version_token') !== itemFacts(change.itemId)?.currentVersionToken) {
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
    return earlier ? null : subjectFor(change, category, { eventId: change.entityId })
  }

  function currentRunCandidate(change: ForgeChange): ForgeNotification | null {
    const reason =
      change.change === 'succeeded'
        ? 'run-succeeded'
        : change.change === 'failed'
          ? 'run-failed'
          : null
    const row = reason
      ? ctx.db
          .prepare('SELECT state, revision, policy_generation FROM runs WHERE id = ?')
          .get(change.entityId)
      : undefined
    const facts = itemFacts(change.itemId)
    if (
      !reason ||
      !row ||
      !facts ||
      rowText(row, 'state') !== change.change ||
      rowNumber(row, 'revision') !== facts.currentRevision ||
      rowNumber(row, 'policy_generation') !== policyGenerationOfItem(ctx, change.itemId)
    ) {
      return null
    }
    return subjectFor(change, reason, { runId: change.entityId })
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

const RUN_REASON_STATE: Partial<Record<ForgeNotificationReason, string>> = {
  'run-succeeded': 'succeeded',
  'run-failed': 'failed'
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
        change: RUN_REASON_STATE[notification.reason] ?? ''
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
