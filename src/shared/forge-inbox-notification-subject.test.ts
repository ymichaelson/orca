import { describe, expect, it } from 'vitest'
import { isForgeInboxNotificationClickTarget } from './forge-inbox-notification-subject'

const valid = {
  subject: {
    ownerId: '11111111-2222-4333-8444-555555555555',
    instanceId: 'gitlab-main',
    itemId: 7,
    reason: 'proposal-pending',
    runId: 12
  },
  executionHostId: 'local'
}

describe('isForgeInboxNotificationClickTarget', () => {
  it('accepts a complete target from the preload bridge', () => {
    expect(isForgeInboxNotificationClickTarget(valid)).toBe(true)
  })

  it('rejects a payload that names no openable item', () => {
    expect(isForgeInboxNotificationClickTarget(null)).toBe(false)
    expect(isForgeInboxNotificationClickTarget('forge')).toBe(false)
    expect(
      isForgeInboxNotificationClickTarget({ ...valid, subject: { ...valid.subject, itemId: 0 } })
    ).toBe(false)
    expect(
      isForgeInboxNotificationClickTarget({
        ...valid,
        subject: { ...valid.subject, itemId: '7' }
      })
    ).toBe(false)
    expect(
      isForgeInboxNotificationClickTarget({ ...valid, subject: { ...valid.subject, ownerId: '' } })
    ).toBe(false)
  })

  it('rejects an unknown reason and a missing route to the owner', () => {
    expect(
      isForgeInboxNotificationClickTarget({
        ...valid,
        subject: { ...valid.subject, reason: 'anything' }
      })
    ).toBe(false)
    expect(isForgeInboxNotificationClickTarget({ subject: valid.subject })).toBe(false)
  })
})
