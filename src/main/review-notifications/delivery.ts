import { Notification, shell } from 'electron'
import { describeReviewEvent, type ReviewEvent, type ReviewPollItem } from './review-event'
import type { ReviewBudgetDelivery } from './review-budget'

export type ReviewNotificationHandle = {
  show: () => void
  close: () => void
  onClick: (listener: () => void) => void
  onAction: (listener: (index: number) => void) => void
  onClose: (listener: () => void) => void
}

export type ReviewNotificationFactory = (
  options: Electron.NotificationConstructorOptions
) => ReviewNotificationHandle

export type ReviewDeliveryDeps = {
  /** Called when the user clicks "Summarize" on a notification. */
  onSummarize: (event: ReviewEvent) => void
  /** Optional push-parity dispatch (e.g. mobile push via the notification controller). */
  dispatchPush?: (event: ReviewEvent) => void
  createNotification?: ReviewNotificationFactory
  openUrl?: (url: string) => Promise<void>
  /** Injected for tests; defaults to the runtime platform. */
  platform?: NodeJS.Platform
}

function notificationKey(event: ReviewEvent): string {
  return [
    event.provider,
    event.host.toLowerCase(),
    event.repo.toLowerCase(),
    event.kind,
    event.iid
  ].join('|')
}

function bodyFor(event: ReviewEvent): string {
  const actor = event.actor ? ` by ${event.actor}` : ''
  return `${event.title}${actor}`
}

/**
 * Desktop delivery for review notifications. Update/resolve are keyed per
 * (provider, host, repo, kind, iid) so a push only ever refreshes or
 * dismisses its own notification — existing notification behavior elsewhere
 * is untouched.
 */
export function createReviewDelivery(deps: ReviewDeliveryDeps): ReviewBudgetDelivery {
  const active = new Map<string, ReviewNotificationHandle>()
  const createNotification: ReviewNotificationFactory =
    deps.createNotification ??
    ((options) => {
      const native = new Notification(options)
      return {
        show: () => native.show(),
        close: () => native.close(),
        onClick: (listener) => native.on('click', listener),
        onAction: (listener) => native.on('action', (_event, index) => listener(index)),
        onClose: (listener) => native.on('close', listener)
      }
    })
  const openUrl = deps.openUrl ?? ((url) => shell.openExternal(url))
  const platform = deps.platform ?? process.platform
  // Electron 43 documents notification `actions` for macOS and Windows only.
  // On Linux the Summarize button would never appear, so the notification
  // click itself becomes the Summarize entry point there; the summary result
  // notification still opens the event URL on click.
  const supportsNotificationActions = platform !== 'linux'

  const showNew = (event: ReviewEvent) => {
    const key = notificationKey(event)
    active.get(key)?.close()
    const options: Electron.NotificationConstructorOptions = {
      title: describeReviewEvent(event),
      body: bodyFor(event)
    }
    if (supportsNotificationActions) {
      options.actions = [{ type: 'button', text: 'Summarize' }]
    }
    const notification = createNotification(options)
    notification.onClick(() => {
      if (supportsNotificationActions) {
        if (event.url) {
          void openUrl(event.url)
        }
      } else {
        deps.onSummarize(event)
      }
    })
    if (supportsNotificationActions) {
      notification.onAction((index) => {
        if (index === 0) {
          deps.onSummarize(event)
        }
      })
    }
    notification.onClose(() => {
      if (active.get(key) === notification) {
        active.delete(key)
      }
    })
    active.set(key, notification)
    notification.show()
    deps.dispatchPush?.(event)
  }

  return {
    deliver: async (items: ReviewPollItem[]) => {
      for (const item of items) {
        const key = notificationKey(item.event)
        if (item.disposition === 'resolve') {
          active.get(key)?.close()
          active.delete(key)
          continue
        }
        if (item.disposition === 'update') {
          const existing = active.get(key)
          if (existing) {
            existing.close()
            active.delete(key)
          }
          // Re-show as a quiet refresh of the same notification.
          showNew(item.event)
          continue
        }
        showNew(item.event)
      }
    },
    deliverDigest: async (repoLabel: string, events: ReviewEvent[]) => {
      const notification = createNotification({
        title: `${events.length} new review items in ${repoLabel}`,
        body: events
          .slice(0, 5)
          .map((e) => `• ${describeReviewEvent(e)}: ${e.title}`)
          .join('\n')
      })
      notification.onClick(() => {
        const first = events.find((e) => e.url)
        if (first?.url) {
          void openUrl(first.url)
        }
      })
      notification.show()
    }
  }
}
