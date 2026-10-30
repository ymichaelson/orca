import { describe, expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ForgeNotificationReason } from '../../shared/forge-inbox-notification-subject'
import { createNotificationDeliveryService } from './notification-delivery-service'

let now = 1_000_000

function setup(overrides: Partial<NotificationSettings> = {}) {
  const settings: NotificationSettings = { ...getDefaultNotificationSettings(), ...overrides }
  const deliverNative = vi.fn(() => ({ delivered: true }) as const)
  const dispatchMobileNotification = vi.fn()
  const service = createNotificationDeliveryService({
    readNotificationSettings: () => settings,
    findActiveWindow: () => null,
    isWindowVisible: () => false,
    setTrayAttention: vi.fn(),
    isNotificationSupported: () => true,
    dispatchMobileNotification,
    readAuthorizationStatus: () => Promise.resolve('authorized'),
    recordDeliveryOutcome: vi.fn(),
    deliverNative,
    platform: 'linux',
    now: () => (now += 120_000)
  })
  return { service, deliverNative, dispatchMobileNotification }
}

const forgeRequest = (
  overrides: Partial<NotificationDispatchRequest> = {}
): NotificationDispatchRequest => ({
  source: 'forge-inbox',
  notificationId: 'forge:owner:gitlab-main:1:review-request',
  attentionKey: 'forge:owner:gitlab-main:1',
  ...overrides
})

const forgeReasonRequest = (reason: ForgeNotificationReason) =>
  forgeRequest({
    notificationId: `forge:owner:gitlab-main:1:${reason}:1`,
    attentionKey: `forge:owner:gitlab-main:1:${reason}`,
    forgeInbox: {
      subject: { ownerId: 'owner', instanceId: 'gitlab-main', itemId: 1, reason, runId: 1 },
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      title: 'Forge Inbox',
      body: 'fixed copy'
    }
  })

describe('forge inbox native notification delivery', () => {
  it('defaults the Forge preference on like the other lanes', () => {
    expect(getDefaultNotificationSettings().forgeInbox).toBe(true)
  })

  it('delivers natively by default and never fans out to the phone lane', () => {
    const { service, deliverNative, dispatchMobileNotification } = setup()

    expect(service.dispatch(forgeRequest())).toEqual({ delivered: true })
    expect(deliverNative).toHaveBeenCalledTimes(1)
    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('never fans back out to the runtime even when the host did not push it', () => {
    const { service, dispatchMobileNotification } = setup()
    service.dispatch(forgeRequest({ mobileDeliveredByHost: false }))
    service.dispatch(forgeRequest({ mobileDeliveredByHost: true }))
    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('stays silent when the Forge preference is off, without touching other lanes', () => {
    const { service, deliverNative } = setup({ forgeInbox: false })

    expect(service.dispatch(forgeRequest())).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
    expect(service.dispatch({ source: 'agent-task-complete', worktreeId: 'wt-1' })).toEqual({
      delivered: true
    })
    expect(deliverNative).toHaveBeenCalledTimes(1)
  })

  it('honours the master switch and a muted machine', () => {
    expect(setup({ enabled: false }).service.dispatch(forgeRequest())).toEqual({
      delivered: false,
      reason: 'disabled'
    })
    const muted = setup({ mutedNotificationSourceIds: ['runtime:box'] })
    expect(muted.service.dispatch(forgeRequest({ notificationSourceId: 'runtime:box' }))).toEqual({
      delivered: false,
      reason: 'host-muted'
    })
    expect(muted.deliverNative).not.toHaveBeenCalled()
  })

  it('still fans an ordinary agent event out to the phone lane', () => {
    const { service, dispatchMobileNotification } = setup()

    service.dispatch({ source: 'agent-task-complete', worktreeId: 'wt-1' })
    expect(dispatchMobileNotification).toHaveBeenCalledTimes(1)
  })

  it('keeps ordinary run completion quiet unless completed runs are opted in', () => {
    const quiet = setup()
    expect(getDefaultNotificationSettings().forgeInboxCompletedRuns).toBe(false)
    expect(quiet.service.dispatch(forgeReasonRequest('run-succeeded'))).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
    expect(quiet.deliverNative).not.toHaveBeenCalled()

    const opted = setup({ forgeInboxCompletedRuns: true })
    expect(opted.service.dispatch(forgeReasonRequest('run-succeeded'))).toEqual({ delivered: true })
    expect(opted.deliverNative).toHaveBeenCalledTimes(1)
  })

  it.each(['run-failed', 'proposal-pending', 'project-event', 'review-request'] as const)(
    'still delivers %s by default',
    (reason) => {
      const { service, deliverNative } = setup()
      expect(service.dispatch(forgeReasonRequest(reason))).toEqual({ delivered: true })
      expect(deliverNative).toHaveBeenCalledTimes(1)
    }
  )

  it('lets the master Forge preference silence everything, completions included', () => {
    const { service, deliverNative } = setup({ forgeInbox: false, forgeInboxCompletedRuns: true })
    for (const reason of ['run-succeeded', 'run-failed', 'project-event'] as const) {
      expect(service.dispatch(forgeReasonRequest(reason))).toEqual({
        delivered: false,
        reason: 'source-disabled'
      })
    }
    expect(deliverNative).not.toHaveBeenCalled()
  })
})
