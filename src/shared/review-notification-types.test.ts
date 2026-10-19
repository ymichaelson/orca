import { describe, expect, it } from 'vitest'
import {
  getDefaultReviewNotificationConfig,
  isReviewNotificationPollingEnabled,
  resolveReviewNotificationConfig,
  resolveReviewNotificationEvents
} from './review-notification-types'

describe('review-notification-types', () => {
  it('defaults to everything off', () => {
    const config = getDefaultReviewNotificationConfig()
    expect(config.enabled).toBe(false)
    expect(config.providers.gitlab).toBeUndefined()
    expect(config.providers.github).toBeUndefined()
    expect(config.mode).toBe('notify')
    expect(config.pollIntervalMinutes).toBe(10)
    expect(config.digest).toBe(true)
    expect(config.maxNotificationsPerHour).toBe(10)
  })

  it('event defaults notify only on opened', () => {
    const config = getDefaultReviewNotificationConfig()
    // events live on providers; the shared default helper covers the shape
    const events = resolveReviewNotificationEvents(undefined)
    expect(events.mrOpened).toBe(true)
    expect(events.issueOpened).toBe(true)
    expect(events.mrUpdated).toBe(false)
    expect(events.mrMerged).toBe(false)
    expect(events.mrClosed).toBe(false)
    expect(events.issueUpdated).toBe(false)
    expect(config).toBeDefined()
  })

  it('resolves absent config to all-off', () => {
    expect(resolveReviewNotificationConfig(undefined).enabled).toBe(false)
    expect(resolveReviewNotificationConfig(null).enabled).toBe(false)
  })

  it('resolves partial configs over defaults without mutating them', () => {
    const resolved = resolveReviewNotificationConfig({ enabled: true })
    expect(resolved.enabled).toBe(true)
    expect(resolved.pollIntervalMinutes).toBe(10)
    expect(getDefaultReviewNotificationConfig().enabled).toBe(false)
  })

  it('isReviewNotificationPollingEnabled requires master switch, global switch, and a valid provider', () => {
    const base = resolveReviewNotificationConfig({ enabled: true })
    expect(isReviewNotificationPollingEnabled(base, true)).toBe(false)
    expect(isReviewNotificationPollingEnabled(undefined, true)).toBe(false)
    expect(isReviewNotificationPollingEnabled(base, false)).toBe(false)

    const gitlab = resolveReviewNotificationConfig({
      enabled: true,
      providers: {
        gitlab: {
          kind: 'gitlab',
          enabled: true,
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          events: resolveReviewNotificationEvents(undefined)
        }
      }
    })
    expect(isReviewNotificationPollingEnabled(gitlab, true)).toBe(true)
    expect(isReviewNotificationPollingEnabled(gitlab, false)).toBe(false)

    const invalidGitlab = resolveReviewNotificationConfig({
      enabled: true,
      providers: {
        gitlab: {
          kind: 'gitlab',
          enabled: true,
          baseUrl: 'https://gitlab.example.com',
          projectId: 0,
          events: resolveReviewNotificationEvents(undefined)
        }
      }
    })
    expect(isReviewNotificationPollingEnabled(invalidGitlab, true)).toBe(false)

    const github = resolveReviewNotificationConfig({
      enabled: true,
      providers: {
        github: {
          kind: 'github',
          enabled: true,
          owner: 'octocat',
          repo: 'hello-world',
          events: resolveReviewNotificationEvents(undefined)
        }
      }
    })
    expect(isReviewNotificationPollingEnabled(github, true)).toBe(true)
  })
})
