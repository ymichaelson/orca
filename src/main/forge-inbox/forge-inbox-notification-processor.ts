import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeNotification } from './forge-inbox-notification-candidates'

export type ForgeNotificationSink = (notification: ForgeNotification) => void

const CLAIM_LIMIT = 50
const PAGES_PER_TURN = 8

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Drains the ledger's notification claims on commit hints. One drain runs at a time, wakes while it
 * runs coalesce into one more pass, and stop() fences synchronously: nothing is published after it,
 * and the returned promise settles once any in-flight drain has stopped touching the ledger.
 */
export function createForgeNotificationProcessor(
  ledger: ForgeInboxLedger,
  sinks: readonly ForgeNotificationSink[]
) {
  let stopped = false
  let draining: Promise<void> | null = null
  let again = false
  const unsubscribe = ledger.onCommitted((hint) => {
    if (hint.changes) {
      wake()
    }
  })

  function publish(notification: ForgeNotification): void {
    for (const sink of sinks) {
      if (stopped || !ledger.notifications.isCurrent(notification)) {
        return
      }
      try {
        sink(notification)
      } catch {
        console.warn('[forge-inbox] notification sink failed')
      }
    }
  }

  async function drain(): Promise<void> {
    do {
      again = false
      for (let page = 0; page < PAGES_PER_TURN && !stopped; page += 1) {
        const claim = ledger.notifications.claim({ limit: CLAIM_LIMIT })
        for (const notification of claim.notifications) {
          publish(notification)
        }
        if (!claim.hasMore) {
          break
        }
        again = true
        await yieldToEventLoop()
      }
    } while (again && !stopped)
  }

  function wake(): void {
    if (stopped) {
      return
    }
    if (draining) {
      again = true
      return
    }
    draining = Promise.resolve()
      .then(drain)
      .catch(() => console.warn('[forge-inbox] notification claim failed'))
      .finally(() => {
        draining = null
        if (again && !stopped) {
          wake()
        }
      })
  }

  return {
    wake,
    stop(): Promise<void> {
      stopped = true
      unsubscribe()
      return draining ?? Promise.resolve()
    }
  }
}

export type ForgeNotificationProcessor = ReturnType<typeof createForgeNotificationProcessor>
