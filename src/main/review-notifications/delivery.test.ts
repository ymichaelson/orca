import { describe, expect, it, vi } from 'vitest'
import {
  createReviewDelivery,
  type ReviewNotificationFactory,
  type ReviewNotificationHandle
} from './delivery'
import type { ReviewEvent } from './review-event'

const event: ReviewEvent = {
  provider: 'gitlab',
  host: 'gitlab.example.com',
  repo: 'gitlab.example.com/projects/42',
  kind: 'mr',
  action: 'opened',
  iid: 7,
  actor: 'alice',
  title: 'Add search',
  url: 'https://gitlab.example.com/-/merge_requests/7',
  updatedAt: '2026-10-19T10:00:00Z'
}

type FakeNotification = ReviewNotificationHandle & {
  options: Electron.NotificationConstructorOptions
  click: () => void
  action: (index: number) => void
}

function makeFakeNotification(
  onCreate: (fake: FakeNotification) => void
): ReviewNotificationFactory {
  return (options) => {
    const clickListeners: (() => void)[] = []
    const actionListeners: ((index: number) => void)[] = []
    const fake: FakeNotification = {
      options,
      show: vi.fn(),
      close: vi.fn(),
      onClick: (listener) => {
        clickListeners.push(listener)
      },
      onAction: (listener) => {
        actionListeners.push(listener)
      },
      onClose: () => {},
      click: () => {
        for (const listener of clickListeners) {
          listener()
        }
      },
      action: (index: number) => {
        for (const listener of actionListeners) {
          listener(index)
        }
      }
    }
    onCreate(fake)
    return fake
  }
}

describe('delivery', () => {
  it('shows a notification with a Summarize action and click-to-open', async () => {
    const created: FakeNotification[] = []
    const onSummarize = vi.fn()
    const openUrl = vi.fn(async () => {})
    const delivery = createReviewDelivery({
      onSummarize,
      openUrl,
      platform: 'darwin',
      createNotification: makeFakeNotification((fake) => created.push(fake))
    })
    await delivery.deliver([{ event, disposition: 'notify' }])
    expect(created).toHaveLength(1)
    expect(created[0].show).toHaveBeenCalled()
    expect(created[0].options.title).toMatch(/merge request/)
    expect(created[0].options.actions).toEqual([{ type: 'button', text: 'Summarize' }])

    // Click opens the URL; the action button triggers Summarize.
    created[0].click()
    expect(openUrl).toHaveBeenCalledWith(event.url)
    expect(onSummarize).not.toHaveBeenCalled()
    created[0].action(0)
    expect(onSummarize).toHaveBeenCalledWith(event)
  })

  it('on Linux omits actions and routes the notification click to Summarize', async () => {
    const created: FakeNotification[] = []
    const onSummarize = vi.fn()
    const openUrl = vi.fn(async () => {})
    const delivery = createReviewDelivery({
      onSummarize,
      openUrl,
      platform: 'linux',
      createNotification: makeFakeNotification((fake) => created.push(fake))
    })
    await delivery.deliver([{ event, disposition: 'notify' }])
    expect(created).toHaveLength(1)
    // Electron 43 does not support notification actions on Linux.
    expect(created[0].options.actions).toBeUndefined()
    // The click itself is the Summarize entry point on Linux.
    created[0].click()
    expect(onSummarize).toHaveBeenCalledWith(event)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('resolve closes the active notification without showing a new one', async () => {
    const created: FakeNotification[] = []
    const delivery = createReviewDelivery({
      onSummarize: () => {},
      createNotification: makeFakeNotification((fake) => created.push(fake))
    })
    await delivery.deliver([{ event, disposition: 'notify' }])
    expect(created).toHaveLength(1)
    await delivery.deliver([{ event: { ...event, action: 'closed' }, disposition: 'resolve' }])
    expect(created).toHaveLength(1)
    expect(created[0].close).toHaveBeenCalled()
  })

  it('delivers a digest as a single notification', async () => {
    const created: FakeNotification[] = []
    const delivery = createReviewDelivery({
      onSummarize: () => {},
      createNotification: makeFakeNotification((fake) => created.push(fake))
    })
    await delivery.deliverDigest('proj', [event, { ...event, iid: 8, title: 'Other' }])
    expect(created).toHaveLength(1)
    expect(created[0].options.title).toMatch(/2 new review items/)
  })
})
