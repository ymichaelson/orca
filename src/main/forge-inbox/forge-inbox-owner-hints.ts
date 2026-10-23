import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeOwnerChangeHint =
  | { kind: 'committed'; ownerHostId: string; changes: boolean; readClientIds: readonly string[] }
  | { kind: 'ended'; reason: 'stopped' | 'owner-changed' | 'open-failed' }

export type ForgeOwnerChangeListener = (hint: ForgeOwnerChangeHint) => void

/**
 * Lets subscribers register while the owner is dormant and attaches the ledger's commit hints on
 * its first open. A subscription is bound to the owner it was told about and is ended, never
 * retargeted, when that owner changes or the service stops.
 */
export function createForgeOwnerHints() {
  const subscribers = new Set<ForgeOwnerChangeListener>()
  let detach: (() => void) | null = null

  function deliver(hint: ForgeOwnerChangeHint, targets: Iterable<ForgeOwnerChangeListener>): void {
    for (const listener of Array.from(targets)) {
      // A listener unsubscribed by an earlier one mid-dispatch (e.g. a closed stream) gets nothing more.
      if (hint.kind === 'committed' && !subscribers.has(listener)) {
        continue
      }
      try {
        listener(hint)
      } catch (error) {
        console.warn('[forge-inbox] change hint listener failed', error)
      }
    }
  }

  function end(reason: 'stopped' | 'owner-changed' | 'open-failed'): void {
    const ended = [...subscribers]
    subscribers.clear()
    deliver({ kind: 'ended', reason }, ended)
  }

  return {
    subscribe(listener: ForgeOwnerChangeListener): () => void {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    /** Subscribers told another owner id are ended before the new ledger can reach them. */
    attach(ledger: ForgeInboxLedger, announcedOwner: string): void {
      if (ledger.hostId !== announcedOwner) {
        end('owner-changed')
      }
      detach = ledger.onCommitted((hint) =>
        deliver({ kind: 'committed', ownerHostId: ledger.hostId, ...hint }, subscribers)
      )
    },
    end(reason: 'stopped' | 'open-failed'): void {
      detach?.()
      detach = null
      end(reason)
    }
  }
}
