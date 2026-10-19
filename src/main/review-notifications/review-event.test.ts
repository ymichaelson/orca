import { describe, expect, it } from 'vitest'
import { describeReviewEvent, fingerprintReviewEvent, type ReviewEvent } from './review-event'

const baseEvent: ReviewEvent = {
  provider: 'gitlab',
  host: 'gitlab.example.com',
  repo: 'gitlab.example.com/projects/42',
  kind: 'mr',
  action: 'opened',
  iid: 123,
  actor: 'alice',
  title: 'Add feature X',
  url: 'https://gitlab.example.com/-/merge_requests/123',
  updatedAt: '2026-10-19T10:00:00Z'
}

describe('review-event', () => {
  it('produces a stable fingerprint for the same event', () => {
    expect(fingerprintReviewEvent(baseEvent)).toBe(fingerprintReviewEvent({ ...baseEvent }))
  })

  it('changes the fingerprint when action or updatedAt changes', () => {
    const opened = fingerprintReviewEvent(baseEvent)
    expect(fingerprintReviewEvent({ ...baseEvent, action: 'ready_for_review' })).not.toBe(opened)
    expect(fingerprintReviewEvent({ ...baseEvent, updatedAt: '2026-10-19T11:00:00Z' })).not.toBe(
      opened
    )
  })

  it('normalizes host/repo casing in the fingerprint', () => {
    expect(fingerprintReviewEvent({ ...baseEvent, host: 'GITLAB.EXAMPLE.COM' })).toBe(
      fingerprintReviewEvent(baseEvent)
    )
  })

  it('describes gitlab MRs with ! and github PRs with #', () => {
    expect(describeReviewEvent(baseEvent)).toBe(
      'New merge request !123 in gitlab.example.com/projects/42'
    )
    expect(
      describeReviewEvent({ ...baseEvent, provider: 'github', host: 'github.com', repo: 'o/r' })
    ).toBe('New pull request #123 in o/r')
    expect(describeReviewEvent({ ...baseEvent, kind: 'issue' })).toBe(
      'New issue #123 in gitlab.example.com/projects/42'
    )
  })
})
