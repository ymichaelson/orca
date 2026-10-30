import type { ExecutionHostId } from './execution-host'

export const FORGE_NOTIFICATION_REASONS = [
  'review-request',
  'participating-update',
  'pipeline-failure',
  'issue-mention',
  'issue-assignment',
  'project-event',
  'run-succeeded',
  'run-failed',
  'proposal-pending'
] as const
export type ForgeNotificationReason = (typeof FORGE_NOTIFICATION_REASONS)[number]

/**
 * What a Forge notification is about. `ownerId` is the durable Inbox owner UUID, not an
 * ExecutionHostId; a client derives the host to open from its own connection to that owner.
 */
export type ForgeInboxNotificationSubject = {
  ownerId: string
  instanceId: string
  itemId: number
  reason: ForgeNotificationReason
  eventId?: number
  runId?: number
  proposalId?: number
  /** Bounded fingerprint of a project-level event, so two different pushes never read as one. */
  trigger?: string
}

/** What a client opens on click: the subject plus the host that client itself reaches the owner through. */
export type ForgeInboxNotificationClickTarget = {
  subject: ForgeInboxNotificationSubject
  executionHostId: ExecutionHostId
}

/** A desktop banner's fixed, host-authored copy plus the item a click opens. */
export type ForgeInboxDesktopNotification = ForgeInboxNotificationClickTarget & {
  title: string
  body: string
}

/** The click payload crosses the preload boundary, so a stale preload must not send us a page target. */
export function isForgeInboxNotificationClickTarget(
  value: unknown
): value is ForgeInboxNotificationClickTarget {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('subject' in value) || typeof value.subject !== 'object' || value.subject === null) {
    return false
  }
  if (!('executionHostId' in value) || typeof value.executionHostId !== 'string') {
    return false
  }
  const subject = value.subject
  if (!('ownerId' in subject) || typeof subject.ownerId !== 'string' || !subject.ownerId) {
    return false
  }
  if (!('instanceId' in subject) || typeof subject.instanceId !== 'string') {
    return false
  }
  if (
    !('itemId' in subject) ||
    typeof subject.itemId !== 'number' ||
    !Number.isSafeInteger(subject.itemId) ||
    subject.itemId <= 0
  ) {
    return false
  }
  if (
    'trigger' in subject &&
    subject.trigger !== undefined &&
    typeof subject.trigger !== 'string'
  ) {
    return false
  }
  return (
    'reason' in subject &&
    typeof subject.reason === 'string' &&
    FORGE_NOTIFICATION_REASONS.some((reason) => reason === subject.reason)
  )
}
