import type { ForgeNotificationReason } from '../../shared/forge-inbox-notification-subject'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { ForgeNotification } from './forge-inbox-notification-candidates'
import type { ForgeNotificationSink } from './forge-inbox-notification-processor'

/** Host-authored and fixed: forge titles, prose, URLs and run errors never reach a system notification. */
const REASON_BODY: Record<ForgeNotificationReason, string> = {
  'review-request': 'A review was requested.',
  'participating-update': 'A merge request you follow changed.',
  'pipeline-failure': 'A pipeline failed.',
  'issue-mention': 'You were mentioned on an issue.',
  'issue-assignment': 'An issue was assigned to you.',
  'run-succeeded': 'An analysis finished.',
  'run-failed': 'An analysis failed.',
  'proposal-pending': 'A proposal is waiting for your approval.'
}

export function forgeNotificationEvent(
  notification: ForgeNotification
): MobileNotificationDispatchEvent {
  const { ownerId, instanceId, itemId, reason, eventId, runId, proposalId } = notification
  const entityId = proposalId ?? runId ?? eventId
  return {
    type: 'notification',
    source: 'forge-inbox',
    title: 'Forge Inbox',
    body: REASON_BODY[reason],
    notificationId: `forge-inbox:${ownerId}:${instanceId}:${itemId}:${reason}:${entityId}`,
    // One burst window per item, so several distinct reasons for it still collapse.
    attentionKey: `forge-inbox:${ownerId}:${instanceId}:${itemId}`,
    forgeInbox: { ownerId, instanceId, itemId, reason, eventId, runId, proposalId }
  }
}

export function createForgeNotificationDispatcher(
  dispatch: (event: MobileNotificationDispatchEvent) => void
): ForgeNotificationSink {
  return (notification) => dispatch(forgeNotificationEvent(notification))
}
