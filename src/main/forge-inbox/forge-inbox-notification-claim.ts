import { runForgeTransaction } from './forge-inbox-database'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  createForgeCandidateReader,
  forgeNotificationPriority,
  type ForgeNotification
} from './forge-inbox-notification-candidates'
import { getForgeClientCursor, listForgeChanges, setForgeClientCursor } from './forge-inbox-queries'

/** Reserved reader id; the prefix cannot be produced by any RPC caller key the host stamps. */
export const FORGE_NOTIFICATION_CURSOR_ID = 'orca-internal:forge-notification-producer'

export type ForgeNotificationClaim = {
  notifications: ForgeNotification[]
  scannedThroughSeq: number
  hasMore: boolean
}

/**
 * Advances the internal cursor in the same transaction that selects the batch, so a notification is
 * attempted at most once: a crash after the commit loses it, and nothing re-offers it.
 */
export function claimForgeNotifications(
  ctx: ForgeLedgerContext,
  options: { limit?: number } = {}
): ForgeNotificationClaim {
  return runForgeTransaction(ctx.db, () => {
    const clientId = FORGE_NOTIFICATION_CURSOR_ID
    const cursor = getForgeClientCursor(ctx, { clientId })
    const page = listForgeChanges(ctx, {}, { afterSeq: cursor, limit: options.limit })
    if (page.changes.length === 0) {
      return { notifications: [], scannedThroughSeq: cursor, hasMore: false }
    }
    const reader = createForgeCandidateReader(ctx)
    const perItem = new Map<number, ForgeNotification>()
    for (const change of page.changes) {
      const candidate = reader.candidateFor(change)
      const kept = candidate ? perItem.get(candidate.itemId) : undefined
      if (
        candidate &&
        (!kept ||
          forgeNotificationPriority(candidate.reason) >= forgeNotificationPriority(kept.reason))
      ) {
        perItem.set(candidate.itemId, candidate)
      }
    }
    setForgeClientCursor(ctx, { clientId, lastSeq: page.nextSeq })
    return {
      notifications: [...perItem.values()].sort((a, b) => a.seq - b.seq),
      scannedThroughSeq: page.nextSeq,
      hasMore: page.hasMore
    }
  })
}
