import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { MobileNotificationEvent } from '../runtime/runtime-mobile-notification-controller'

/**
 * Forge attention already rides the runtime's fan-out. This desktop consumes that lane once,
 * adding the click target its own host can open; the subject's owner UUID is not an execution host.
 */
export function forgeInboxDesktopRequest(
  event: MobileNotificationEvent
): NotificationDispatchRequest | null {
  if (event.type !== 'notification' || event.source !== 'forge-inbox' || !event.forgeInbox) {
    return null
  }
  return {
    source: 'forge-inbox',
    ...(event.notificationId ? { notificationId: event.notificationId } : {}),
    ...(event.attentionKey ? { attentionKey: event.attentionKey } : {}),
    forgeInbox: {
      subject: event.forgeInbox,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      title: event.title,
      body: event.body
    }
  }
}

/** Live-only by construction: `onDispatched` never replays history, so a restart raises no old banner. */
export function createForgeInboxDesktopNotifier(
  dispatch: (request: NotificationDispatchRequest) => unknown
): (event: MobileNotificationEvent) => void {
  return (event) => {
    const request = forgeInboxDesktopRequest(event)
    if (request !== null) {
      void dispatch(request)
    }
  }
}
