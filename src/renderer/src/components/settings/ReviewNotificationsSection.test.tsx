// @vitest-environment happy-dom

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import {
  getDefaultReviewNotificationEvents,
  resolveReviewNotificationConfig
} from '../../../../shared/review-notification-types'
import { PSEUDO_LOCALIZATION_LOCALE } from '../../i18n/pseudo-localization'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { ReviewNotificationsSection } from './ReviewNotificationsSection'

function enabledRepo(): Repo {
  return {
    id: 'r1',
    path: '/tmp/r1',
    displayName: 'proj',
    badgeColor: '#fff',
    addedAt: Date.now(),
    reviewNotifications: resolveReviewNotificationConfig({
      enabled: true,
      providers: {
        gitlab: {
          kind: 'gitlab',
          enabled: true,
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          events: getDefaultReviewNotificationEvents()
        }
      }
    })
  }
}

function setStore() {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), reviewNotificationsEnabled: true },
    updateSettings: vi.fn()
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  setStore()
})

afterEach(() => {
  cleanup()
})

describe('ReviewNotificationsSection', () => {
  it('routes event toggle labels through i18n (pseudo-localized under en-XA)', async () => {
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    try {
      const markup = renderToStaticMarkup(
        React.createElement(ReviewNotificationsSection, {
          repo: enabledRepo(),
          updateRepo: vi.fn()
        })
      )
      // Labels resolved via tr() get pseudo-localized brackets; hardcoded
      // English strings would appear unwrapped.
      expect(markup).toContain('[New merge request / pull request]')
      expect(markup).toContain('[Merge request / pull request updated]')
      expect(markup).toContain('[New issue]')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('does not clobber the poll interval while the field is cleared', () => {
    const updateRepo = vi.fn()
    const { container } = render(
      <ReviewNotificationsSection repo={enabledRepo()} updateRepo={updateRepo} />
    )
    const input = container.querySelector<HTMLInputElement>('#review-notifications-interval-r1')
    expect(input).not.toBeNull()
    // Clearing the field must not snap the saved value to the default.
    fireEvent.change(input!, { target: { value: '' } })
    expect(updateRepo).not.toHaveBeenCalled()
    // Typing a fresh value saves it as-is (no "105" clobbering).
    fireEvent.change(input!, { target: { value: '5' } })
    expect(updateRepo).toHaveBeenCalledWith('r1', {
      reviewNotifications: expect.objectContaining({ pollIntervalMinutes: 5 })
    })
  })

  it('does not clobber max-notifications-per-hour while the field is cleared', () => {
    const updateRepo = vi.fn()
    const { container } = render(
      <ReviewNotificationsSection repo={enabledRepo()} updateRepo={updateRepo} />
    )
    const input = container.querySelector<HTMLInputElement>('#review-notifications-maxhour-r1')
    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { value: '' } })
    expect(updateRepo).not.toHaveBeenCalled()
    fireEvent.change(input!, { target: { value: '3' } })
    expect(updateRepo).toHaveBeenCalledWith('r1', {
      reviewNotifications: expect.objectContaining({ maxNotificationsPerHour: 3 })
    })
  })

  it('floors fractional values in numeric fields', () => {
    const updateRepo = vi.fn()
    const { container } = render(
      <ReviewNotificationsSection repo={enabledRepo()} updateRepo={updateRepo} />
    )
    const input = container.querySelector<HTMLInputElement>(
      '#review-notifications-gitlab-projectid-r1'
    )
    expect(input).not.toBeNull()
    // A fractional project ID would produce an invalid GitLab API path.
    fireEvent.change(input!, { target: { value: '2.5' } })
    expect(updateRepo).toHaveBeenCalledWith('r1', {
      reviewNotifications: expect.objectContaining({
        providers: expect.objectContaining({
          gitlab: expect.objectContaining({ projectId: 2 })
        })
      })
    })
  })
})
