import type { ForgeLedgerContext } from './forge-inbox-context'
import { isForgeNotificationCurrent } from './forge-inbox-notification-candidates'
import { claimForgeNotifications } from './forge-inbox-notification-claim'

/**
 * Host-private notification surface of a ledger. `claim` is at-most-once: its internal cursor commits
 * with the batch, so a lost batch is never retried. `isCurrent` is false once a claimed notice was
 * overtaken by a policy bump, a newer revision or a disabled project.
 */
export function createForgeNotificationFeed(ctx: ForgeLedgerContext) {
  return {
    claim: (options?: Parameters<typeof claimForgeNotifications>[1]) =>
      claimForgeNotifications(ctx, options),
    isCurrent: (notification: Parameters<typeof isForgeNotificationCurrent>[1]) =>
      isForgeNotificationCurrent(ctx, notification)
  }
}
