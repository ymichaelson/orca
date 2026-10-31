import { runForgeTransaction } from './forge-inbox-database'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  createForgeCandidateReader,
  forgeNotificationPriority,
  type ForgeNotification
} from './forge-inbox-notification-candidates'
import {
  getForgeClientCursor,
  listForgeChanges,
  setForgeClientCursor
} from './forge-inbox-change-cursors'

/** Reserved reader id; the prefix cannot be produced by any RPC caller key the host stamps. */
export const FORGE_NOTIFICATION_CURSOR_ID = 'orca-internal:forge-notification-producer'

export type ForgeNotificationClaim = {
  notifications: ForgeNotification[]
  scannedThroughSeq: number
  hasMore: boolean
}

/** A verdict or a proposal already says the agent's work needs a person, so it speaks for that work. */
const ABSORBING_PRIORITY = forgeNotificationPriority('run-failed')

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
    // Every trigger is announced on its own: nothing is folded into another item's message. Only an
    // attention that promises the same alert may absorb a lower-ranked one raised later on that item.
    const notifications: ForgeNotification[] = []
    const absorbable = new Map<number, ForgeNotification>()
    for (const change of page.changes) {
      const candidate = reader.candidateFor(change)
      if (!candidate) {
        continue
      }
      const held = absorbable.get(candidate.itemId)
      const rank = forgeNotificationPriority(candidate.reason)
      if (held !== undefined && rank <= forgeNotificationPriority(held.reason)) {
        continue
      }
      if (held !== undefined) {
        notifications.splice(notifications.indexOf(held), 1)
      }
      notifications.push(candidate)
      if (rank >= ABSORBING_PRIORITY) {
        absorbable.set(candidate.itemId, candidate)
      } else {
        absorbable.delete(candidate.itemId)
      }
    }
    setForgeClientCursor(ctx, { clientId, lastSeq: page.nextSeq })
    return {
      notifications: notifications.sort((a, b) => a.seq - b.seq),
      scannedThroughSeq: page.nextSeq,
      hasMore: page.hasMore
    }
  })
}
