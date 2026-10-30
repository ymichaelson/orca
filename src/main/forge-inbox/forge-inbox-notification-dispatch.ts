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
  'project-event': 'A project event needs your attention.',
  'run-succeeded': 'An analysis finished.',
  'run-failed': 'An analysis failed.',
  'proposal-pending': 'A proposal is waiting for your approval.'
}

export function forgeNotificationCopy(reason: ForgeNotificationReason): {
  title: string
  body: string
} {
  return { title: 'Forge Inbox', body: REASON_BODY[reason] }
}

export function forgeNotificationEvent(
  notification: ForgeNotification
): MobileNotificationDispatchEvent {
  const { ownerId, instanceId, itemId, reason, eventId, runId, proposalId, trigger } = notification
  const entityId = proposalId ?? runId ?? eventId
  // Why: pushes share one project item, so the trigger tells their bursts apart.
  const item = trigger === undefined ? `${itemId}` : `${itemId}:${trigger}`
  return {
    type: 'notification',
    source: 'forge-inbox',
    ...forgeNotificationCopy(reason),
    notificationId: `forge-inbox:${ownerId}:${instanceId}:${itemId}:${reason}:${entityId}`,
    // One burst window per item, so several distinct reasons for it still collapse.
    attentionKey: `forge-inbox:${ownerId}:${instanceId}:${item}`,
    forgeInbox: { ownerId, instanceId, itemId, reason, eventId, runId, proposalId, trigger }
  }
}

export function createForgeNotificationDispatcher(
  dispatch: (event: MobileNotificationDispatchEvent) => void
): ForgeNotificationSink {
  return (notification) => dispatch(forgeNotificationEvent(notification))
}
