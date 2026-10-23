import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { MobileNotificationEvent } from '../runtime/runtime-mobile-notification-controller'
import { buildNotificationOptions } from '../ipc/notification-options'
import {
  createForgeInboxDesktopNotifier,
  forgeInboxDesktopRequest
} from './forge-inbox-desktop-notifier'

const subject = {
  ownerId: '11111111-2222-4333-8444-555555555555',
  instanceId: 'gitlab-main',
  itemId: 7,
  reason: 'review-request'
} as const

function forgeEvent(overrides: { title?: string; body?: string } = {}): MobileNotificationEvent {
  return {
    type: 'notification',
    source: 'forge-inbox',
    title: overrides.title ?? 'Forge Inbox',
    body: overrides.body ?? 'A review was requested.',
    notificationId: 'forge-inbox:owner:gitlab-main:7:review-request:3',
    attentionKey: 'forge-inbox:owner:gitlab-main:7',
    forgeInbox: subject
  }
}

describe('forge inbox desktop notifications', () => {
  it('pins the click target to this host and keeps the item identity', () => {
    expect(forgeInboxDesktopRequest(forgeEvent())).toEqual({
      source: 'forge-inbox',
      notificationId: 'forge-inbox:owner:gitlab-main:7:review-request:3',
      attentionKey: 'forge-inbox:owner:gitlab-main:7',
      forgeInbox: {
        subject,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        title: 'Forge Inbox',
        body: 'A review was requested.'
      }
    })
  })

  it('banners only the host-authored copy, never anything the event carries as model prose', () => {
    const request = forgeInboxDesktopRequest(forgeEvent({ title: 'Forge Inbox' }))
    if (request === null) {
      throw new Error('expected a Forge request')
    }
    // Why: the request shape is the one the delivery path reads, so this proves what a banner says.
    expect(buildNotificationOptions(request)).toEqual({
      title: 'Forge Inbox',
      body: 'A review was requested.'
    })
  })

  it('ignores every other lane, dismissals, and Forge events without a subject', () => {
    expect(
      forgeInboxDesktopRequest({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'Done',
        body: 'Finished'
      })
    ).toBeNull()
    expect(forgeInboxDesktopRequest({ type: 'dismiss', notificationId: 'forge:x' })).toBeNull()
    expect(
      forgeInboxDesktopRequest({
        type: 'notification',
        source: 'forge-inbox',
        title: 'Forge Inbox',
        body: 'A pipeline failed.'
      })
    ).toBeNull()
  })

  it('dispatches each live Forge event once and nothing else', () => {
    const dispatch = vi.fn<(request: NotificationDispatchRequest) => void>()
    const notify = createForgeInboxDesktopNotifier(dispatch)

    notify(forgeEvent())
    notify({ type: 'notification', source: 'terminal-bell', title: 'Bell', body: 'Attention' })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].forgeInbox?.subject).toEqual(subject)
  })
})
