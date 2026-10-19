import { createHash } from 'node:crypto'
import type {
  ReviewNotificationAction,
  ReviewNotificationKind
} from '../../shared/review-notification-types'

/** Provider-agnostic review event. GitHub PRs map to kind 'mr' internally. */
export type ReviewEvent = {
  provider: 'gitlab' | 'github'
  /** Hostname, e.g. "gitlab.example.com" or "github.com". */
  host: string
  /** "group/project" or "owner/repo". */
  repo: string
  kind: ReviewNotificationKind
  action: ReviewNotificationAction
  /** Provider-local number: MR !123 / PR #45 / issue #67. */
  iid: number
  /** Username that triggered the event. */
  actor: string
  title: string
  url: string
  /** ISO 8601 of the provider's updated_at. */
  updatedAt: string
  /**
   * Transition signals from the list endpoints. Optional: sources that cannot
   * provide a signal leave it absent and the poller treats it as unchanged.
   */
  meta?: {
    draft?: boolean
    labels?: string[]
    reviewers?: string[]
  }
}

/**
 * Per-kind listing cursors passed to a source. MR and issue listings advance
 * independently: sharing one cursor lets the newer kind skip the other kind's
 * unfetched pages past per_page.
 */
export type ReviewListingCursors = {
  mrSince: string
  issueSince: string
}

/** Stable identity: the same provider event always yields the same fingerprint. */
export function fingerprintReviewEvent(event: ReviewEvent): string {
  const parts = [
    event.provider,
    event.host.toLowerCase(),
    event.repo.toLowerCase(),
    event.kind,
    String(event.iid),
    event.action,
    event.updatedAt
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/** Human-readable one-liner for notification titles. */
export function describeReviewEvent(event: ReviewEvent): string {
  const unit =
    event.provider === 'gitlab'
      ? event.kind === 'mr'
        ? `!${event.iid}`
        : `#${event.iid}`
      : `#${event.iid}`
  const noun =
    event.provider === 'gitlab'
      ? event.kind === 'mr'
        ? 'merge request'
        : 'issue'
      : event.kind === 'mr'
        ? 'pull request'
        : 'issue'
  return `New ${noun} ${unit} in ${event.repo}`
}

export type ReviewPollDisposition = 'notify' | 'update' | 'resolve'

export type ReviewPollItem = {
  event: ReviewEvent
  disposition: ReviewPollDisposition
}

/** Latest updatedAt across events, if any. */
export function maxUpdatedAt(events: ReviewEvent[]): string | undefined {
  return events
    .map((e) => e.updatedAt)
    .filter(Boolean)
    .sort()
    .pop()
}
