import { describe, expect, it } from 'vitest'
import { advanceListingCursors, queryCursors, readListingCursors } from './listing-cursors'
import { createInMemoryWatermarkStore, watermarkKey } from './dedup'
import type { ReviewEvent } from './review-event'

function event(iid: number, updatedAt: string): ReviewEvent {
  return {
    provider: 'gitlab',
    host: 'gitlab.example.com',
    repo: 'gitlab.example.com/projects/42',
    kind: 'mr',
    action: 'opened',
    iid,
    actor: 'alice',
    title: `MR ${iid}`,
    url: `https://gitlab.example.com/-/merge_requests/${iid}`,
    updatedAt
  }
}

const key = (kind: 'mr-open' | 'mr-closed' | 'issue-open' | 'issue-closed') =>
  watermarkKey('gitlab', 'gitlab.example.com', 'gitlab.example.com/projects/42', kind)

describe('listing-cursors', () => {
  it('reads each cursor independently, defaulting to the poll window start', () => {
    const store = createInMemoryWatermarkStore()
    store.setWatermark(key('mr-open'), '2026-10-19T11:05:00.000Z')
    const cursors = readListingCursors(
      store,
      'gitlab',
      'gitlab.example.com',
      'gitlab.example.com/projects/42',
      '2026-10-19T11:00:00.000Z'
    )
    expect(cursors.mrOpen).toBe('2026-10-19T11:05:00.000Z')
    expect(cursors.mrClosed).toBe('2026-10-19T11:00:00.000Z')
    expect(cursors.issueOpen).toBe('2026-10-19T11:00:00.000Z')
    expect(cursors.issueClosed).toBe('2026-10-19T11:00:00.000Z')
  })

  it('queries with the skew overlap so exclusive windows cannot skip ties', () => {
    const q = queryCursors({
      mrOpen: '2026-10-19T11:05:00.000Z',
      mrClosed: '2026-10-19T11:00:00.000Z',
      issueOpen: '2026-10-19T11:10:00.000Z',
      issueClosed: '2026-10-19T11:00:00.000Z'
    })
    expect(q.open).toEqual({
      mrSince: '2026-10-19T11:04:00.000Z',
      issueSince: '2026-10-19T11:09:00.000Z'
    })
    expect(q.closed).toEqual({
      mrSince: '2026-10-19T10:59:00.000Z',
      issueSince: '2026-10-19T10:59:00.000Z'
    })
  })

  it('advances each cursor only from its own listing', () => {
    const store = createInMemoryWatermarkStore()
    const since = {
      mrOpen: '2026-10-19T11:00:00.000Z',
      mrClosed: '2026-10-19T11:00:00.000Z',
      issueOpen: '2026-10-19T11:00:00.000Z',
      issueClosed: '2026-10-19T11:00:00.000Z'
    }
    advanceListingCursors(
      store,
      'gitlab',
      'gitlab.example.com',
      'gitlab.example.com/projects/42',
      since,
      { mrs: [event(1, '2026-10-19T11:05:00Z')], issues: [event(2, '2026-10-19T11:10:00Z')] },
      { mrs: [], issues: [] }
    )
    // Normalized on store: the MR cursor must not see the issue timestamp.
    expect(store.getWatermark(key('mr-open'))).toBe('2026-10-19T11:05:00.000Z')
    expect(store.getWatermark(key('issue-open'))).toBe('2026-10-19T11:10:00.000Z')
    // A listing with nothing newer keeps its cursor: jumping to the local now
    // risks skipping items updated after the forge ran the query.
    expect(store.getWatermark(key('mr-closed'))).toBe('2026-10-19T11:00:00.000Z')
  })

  it('never moves a cursor backwards on clock skew', () => {
    const store = createInMemoryWatermarkStore()
    store.setWatermark(key('mr-open'), '2026-10-19T12:00:00.000Z')
    advanceListingCursors(
      store,
      'gitlab',
      'gitlab.example.com',
      'gitlab.example.com/projects/42',
      {
        mrOpen: '2026-10-19T12:00:00.000Z',
        mrClosed: '2026-10-19T11:00:00.000Z',
        issueOpen: '2026-10-19T11:00:00.000Z',
        issueClosed: '2026-10-19T11:00:00.000Z'
      },
      { mrs: [event(1, '2026-10-19T11:30:00Z')], issues: [] },
      { mrs: [], issues: [] }
    )
    // A listing older than the cursor keeps the cursor: never rewinds to the
    // stale item's timestamp, never jumps to now.
    expect(store.getWatermark(key('mr-open'))).toBe('2026-10-19T12:00:00.000Z')
  })
})
