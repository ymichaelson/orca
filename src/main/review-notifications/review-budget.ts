import type { ReviewEvent, ReviewPollItem } from './review-event'

export type ReviewBudgetDelivery = {
  deliver: (items: ReviewPollItem[]) => Promise<void>
  deliverDigest: (repoLabel: string, events: ReviewEvent[]) => Promise<void>
}

const WINDOW_MS = 60 * 60 * 1000

/**
 * Hourly per-repo notification budget. Overflow goes to a digest (when
 * enabled) instead of spamming; without digest it is dropped silently.
 */
export class ReviewNotificationBudget {
  private windowStart: number
  private sentInWindow = 0
  private digestBuffer: ReviewEvent[] = []

  constructor(private now: () => number = Date.now) {
    this.windowStart = this.now()
  }

  async apply(args: {
    repoLabel: string
    items: ReviewPollItem[]
    maxPerHour: number
    digest: boolean
    delivery: ReviewBudgetDelivery
  }): Promise<ReviewPollItem[]> {
    const { repoLabel, items, maxPerHour, digest, delivery } = args
    const now = this.now()
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now
      this.sentInWindow = 0
    }
    const deliverable: ReviewPollItem[] = []
    for (const item of items) {
      if (item.disposition !== 'notify') {
        deliverable.push(item)
        continue
      }
      if (this.sentInWindow < maxPerHour) {
        this.sentInWindow += 1
        deliverable.push(item)
      } else if (digest) {
        this.digestBuffer.push(item.event)
      }
    }
    if (deliverable.length > 0) {
      await delivery.deliver(deliverable)
    }
    if (this.digestBuffer.length > 0) {
      const digestEvents = this.digestBuffer
      this.digestBuffer = []
      await delivery.deliverDigest(repoLabel, digestEvents)
    }
    return deliverable
  }
}
