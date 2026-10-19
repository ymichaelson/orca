import {
  advanceWatermark,
  skewBack,
  watermarkKey,
  type ReviewWatermarkKind,
  type ReviewWatermarkStore
} from './dedup'
import { maxUpdatedAt, type ReviewEvent, type ReviewListingCursors } from './review-event'

/**
 * One independent cursor per listing. MR and issue listings must never share
 * a cursor: with per_page limits, a newer item of one kind would otherwise
 * advance the cursor past the other kind's unfetched pages, skipping them on
 * the next poll. Open and closed listings are independent for the same reason.
 */
export type ListingCursorSet = {
  mrOpen: string
  mrClosed: string
  issueOpen: string
  issueClosed: string
}

const CURSOR_ENTRIES = [
  ['mr-open', 'mrOpen'],
  ['mr-closed', 'mrClosed'],
  ['issue-open', 'issueOpen'],
  ['issue-closed', 'issueClosed']
] as const satisfies readonly (readonly [ReviewWatermarkKind, keyof ListingCursorSet])[]

export function readListingCursors(
  store: ReviewWatermarkStore,
  provider: string,
  host: string,
  slug: string,
  pollWindowStart: string
): ListingCursorSet {
  const keyOf = (kind: ReviewWatermarkKind): string => watermarkKey(provider, host, slug, kind)
  return {
    mrOpen: store.getWatermark(keyOf('mr-open')) ?? pollWindowStart,
    mrClosed: store.getWatermark(keyOf('mr-closed')) ?? pollWindowStart,
    issueOpen: store.getWatermark(keyOf('issue-open')) ?? pollWindowStart,
    issueClosed: store.getWatermark(keyOf('issue-closed')) ?? pollWindowStart
  }
}

/**
 * Query-time overlap: forge `updated_after`/`since` windows are exclusive and
 * second-precision, so querying each cursor minus the skew catches
 * same-second ties. Overlap items are reprocessed but deduped by
 * fingerprints/snapshots.
 */
export function overlapCursor(cursor: string): string {
  return skewBack(cursor)
}

export function queryCursors(cursors: ListingCursorSet): {
  open: ReviewListingCursors
  closed: ReviewListingCursors
} {
  return {
    open: { mrSince: overlapCursor(cursors.mrOpen), issueSince: overlapCursor(cursors.issueOpen) },
    closed: {
      mrSince: overlapCursor(cursors.mrClosed),
      issueSince: overlapCursor(cursors.issueClosed)
    }
  }
}

/**
 * Advance each cursor only from its own listing's newest timestamp. With
 * sources fetching every page, the cursor always moves to the newest seen
 * item, so a burst inside the old 60s overlap can no longer pin the cursor
 * and refetch the same set forever. A listing with nothing newer keeps its
 * cursor: jumping to the local now risks skipping items updated after the
 * forge ran the query (slow polls) or when the local clock runs ahead.
 * Re-scanning the 60s overlap is harmless: fingerprints dedup open items.
 */
export function advanceListingCursors(
  store: ReviewWatermarkStore,
  provider: string,
  host: string,
  slug: string,
  since: ListingCursorSet,
  listed: { mrs: ReviewEvent[]; issues: ReviewEvent[] },
  closed: { mrs: ReviewEvent[]; issues: ReviewEvent[] }
): void {
  const itemsOf: Record<keyof ListingCursorSet, ReviewEvent[]> = {
    mrOpen: listed.mrs,
    issueOpen: listed.issues,
    mrClosed: closed.mrs,
    issueClosed: closed.issues
  }
  for (const [kind, field] of CURSOR_ENTRIES) {
    const max = maxUpdatedAt(itemsOf[field])
    // Numeric instant comparison: forge timestamps and Date.toISOString()
    // spell the same instant differently ("…00Z" vs "…00.000Z"), which breaks
    // lexicographic comparison. Stored normalized for the same reason.
    const previous = since[field]
    const candidate =
      max && Date.parse(max) > Date.parse(previous) ? new Date(max).toISOString() : previous
    advanceWatermark(store, watermarkKey(provider, host, slug, kind), candidate)
  }
}
