import type {
  ForgeNotificationReason,
  ForgeNotificationTrigger
} from '../../shared/forge-inbox-notification-subject'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { ForgeNotification } from './forge-inbox-notification-candidates'
import type { ForgeNotificationSink } from './forge-inbox-notification-processor'

/**
 * Host-authored and fixed: forge titles, prose, URLs and run errors never reach a system
 * notification. The trigger's name is the only part of an event that is said.
 */
const REASON_BODY: Record<
  ForgeNotificationReason,
  (action: ForgeNotificationTrigger | null) => string
> = {
  'merge-request-opened': () => 'A merge request was opened.',
  'merge-request-approved': () => 'A merge request was approved.',
  'merge-request-merged': () => 'A merge request was merged.',
  'merge-request-closed': () => 'A merge request was closed.',
  'note-added': () => 'A new comment was added.',
  'issue-opened': () => 'An issue was opened.',
  'issue-closed': () => 'An issue was closed.',
  push: () => 'New commits were pushed.',
  'tag-push': () => 'A tag was pushed.',
  release: () => 'A release was created or changed.',
  deployment: () => 'A deployment happened.',
  'review-request': () => 'A review was requested.',
  'participating-update': () => 'A merge request you follow changed.',
  'pipeline-failure': () => 'A pipeline failed.',
  'issue-mention': () => 'You were mentioned on an issue.',
  'issue-assignment': () => 'An issue was assigned to you.',
  'project-event': () => 'A project event needs your attention.',
  'run-succeeded': () => 'An analysis finished.',
  'run-failed': () => 'An analysis failed.',
  'proposal-pending': () => 'A proposal is waiting for your approval.'
}

export function forgeNotificationCopy(
  reason: ForgeNotificationReason,
  action: ForgeNotificationTrigger | null = null
): { title: string; body: string } {
  return { title: 'Forge Inbox', body: REASON_BODY[reason](action) }
}

export function forgeNotificationEvent(
  notification: ForgeNotification
): MobileNotificationDispatchEvent {
  const { ownerId, instanceId, itemId, reason, eventId, runId, proposalId, trigger, action } =
    notification
  const entityId = proposalId ?? runId ?? eventId
  // Why: each trigger has its own item, so the item alone names the burst.
  const item = `${itemId}`
  return {
    type: 'notification',
    source: 'forge-inbox',
    ...forgeNotificationCopy(reason, action ?? null),
    notificationId: `forge-inbox:${ownerId}:${instanceId}:${itemId}:${reason}:${entityId}`,
    // One burst window per item, so several distinct reasons for it still collapse.
    attentionKey: `forge-inbox:${ownerId}:${instanceId}:${item}`,
    forgeInbox: {
      ownerId,
      instanceId,
      itemId,
      reason,
      eventId,
      runId,
      proposalId,
      trigger,
      ...(action === undefined ? {} : { action })
    }
  }
}

export function createForgeNotificationDispatcher(
  dispatch: (event: MobileNotificationDispatchEvent) => void
): ForgeNotificationSink {
  return (notification) => dispatch(forgeNotificationEvent(notification))
}
