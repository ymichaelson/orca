import { FORGE_INBOX_NOTIFICATION_READER_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import type { MobileNotificationEvent } from '../../runtime-mobile-notification-controller'

/** Forge events reach only a connection that authenticated as a Forge notification reader. */
export function createNotificationStreamFilter(
  includeDesktopSuppressed = false,
  clientCapabilities: readonly RuntimeCapability[] = []
) {
  const readsForge = clientCapabilities.includes(FORGE_INBOX_NOTIFICATION_READER_CAPABILITY)
  return (event: MobileNotificationEvent): boolean =>
    (readsForge || event.type !== 'notification' || event.source !== 'forge-inbox') &&
    (includeDesktopSuppressed ||
      event.type !== 'notification' ||
      (event.desktopAllowed !== false && event.legacySocketAllowed !== false))
}
