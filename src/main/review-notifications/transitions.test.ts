import { describe, expect, it } from 'vitest'
import {
  applyTransition,
  classifyTransition,
  shouldNotifyForAction,
  type ItemSnapshot
} from './transitions'
import { resolveReviewNotificationEvents } from '../../shared/review-notification-types'
import type { ReviewEvent } from './review-event'

const snapshot = (overrides: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
  iid: 1,
  updatedAt: '2026-10-19T10:00:00Z',
  draft: false,
  reviewers: [],
  labels: [],
  title: 'T',
  ...overrides
})

const baseEvent: ReviewEvent = {
  provider: 'gitlab',
  host: 'gitlab.example.com',
  repo: 'x',
  kind: 'mr',
  action: 'opened',
  iid: 1,
  actor: 'a',
  title: 'T',
  url: 'u',
  updatedAt: '2026-10-19T10:00:00Z'
}

describe('transitions', () => {
  it('classifies first sighting as opened', () => {
    expect(classifyTransition(undefined, snapshot(), [])).toEqual({ action: 'opened' })
  })

  it('classifies draft -> ready as ready_for_review', () => {
    expect(classifyTransition(snapshot({ draft: true }), snapshot({ draft: false }), [])).toEqual({
      action: 'ready_for_review'
    })
  })

  it('classifies a newly added reviewer as review_requested', () => {
    expect(
      classifyTransition(snapshot({ reviewers: [] }), snapshot({ reviewers: ['bob'] }), [])
    ).toEqual({ action: 'review_requested' })
  })

  it('classifies a watched label as labeled, other labels as updated', () => {
    expect(
      classifyTransition(snapshot({ labels: [] }), snapshot({ labels: ['urgent'] }), ['urgent'])
    ).toEqual({ action: 'labeled', label: 'urgent' })
    expect(
      classifyTransition(snapshot({ labels: [] }), snapshot({ labels: ['docs'] }), ['urgent'])
    ).toEqual({ action: 'updated' })
  })

  it('label matching is case-insensitive', () => {
    expect(
      classifyTransition(snapshot({ labels: [] }), snapshot({ labels: ['Urgent'] }), ['urgent'])
    ).toEqual({ action: 'labeled', label: 'Urgent' })
  })

  it('notifies only on meaningful transitions by default', () => {
    const toggles = resolveReviewNotificationEvents(undefined)
    expect(shouldNotifyForAction('opened', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('opened', 'issue', toggles)).toBe(true)
    expect(shouldNotifyForAction('reopened', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('review_requested', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('ready_for_review', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('labeled', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('updated', 'mr', toggles)).toBe(false)
    expect(shouldNotifyForAction('merged', 'mr', toggles)).toBe(false)
    expect(shouldNotifyForAction('closed', 'mr', toggles)).toBe(false)
  })

  it('honors explicit updated/merged/closed toggles', () => {
    const toggles = resolveReviewNotificationEvents({ mrUpdated: true, mrMerged: true })
    expect(shouldNotifyForAction('updated', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('merged', 'mr', toggles)).toBe(true)
    expect(shouldNotifyForAction('closed', 'mr', toggles)).toBe(false)
  })

  it('applyTransition returns null for silent transitions', () => {
    const toggles = resolveReviewNotificationEvents(undefined)
    expect(applyTransition(baseEvent, { action: 'updated' }, 'mr', toggles)).toBeNull()
    const opened = applyTransition(baseEvent, { action: 'opened' }, 'mr', toggles)
    expect(opened?.action).toBe('opened')
  })
})
