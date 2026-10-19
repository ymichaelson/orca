import type {
  ReviewNotificationEventToggles,
  ReviewNotificationKind
} from '../../shared/review-notification-types'
import type { ReviewEvent } from './review-event'

/**
 * Transition classification for review events.
 *
 * The list endpoints only show current state, so the poller diffs the current
 * snapshot against the last-seen snapshot for each (provider, host, repo,
 * kind, iid) to derive transitions:
 * - first seen                    -> opened
 * - draft true -> false           -> ready_for_review
 * - reviewer added (gitlab)       -> review_requested
 * - watched label added           -> labeled
 * - updated_at advanced, no other transition -> updated
 *
 * Merged/closed items are detected with a separate closed-state listing (see
 * review-classify.ts): the open listing is a delta, so an item missing from it
 * proves nothing and must never resolve its notification.
 *
 * Only opened / reopened / review_requested / ready_for_review / labeled
 * (watched labels) ever notify. `updated` refreshes the existing notification
 * in place; merged/closed dismiss it.
 */

export type ItemSnapshot = {
  iid: number
  updatedAt: string
  draft: boolean
  reviewers: string[]
  labels: string[]
  title: string
}

export type Transition =
  | { action: 'opened' }
  | { action: 'ready_for_review' }
  | { action: 'review_requested' }
  | { action: 'labeled'; label: string }
  | { action: 'updated' }

export function classifyTransition(
  previous: ItemSnapshot | undefined,
  current: ItemSnapshot,
  watchedLabels: string[]
): Transition {
  if (!previous) {
    return { action: 'opened' }
  }
  if (previous.draft && !current.draft) {
    return { action: 'ready_for_review' }
  }
  const newReviewers = current.reviewers.filter((r) => !previous.reviewers.includes(r))
  if (newReviewers.length > 0) {
    return { action: 'review_requested' }
  }
  const watched = new Set(watchedLabels.map((l) => l.toLowerCase()))
  const newLabels = current.labels.filter(
    (l) => !previous.labels.map((p) => p.toLowerCase()).includes(l.toLowerCase())
  )
  const hit = newLabels.find((l) => watched.has(l.toLowerCase()))
  if (hit) {
    return { action: 'labeled', label: hit }
  }
  return { action: 'updated' }
}

const NOTIFY_ACTIONS = new Set([
  'opened',
  'reopened',
  'review_requested',
  'ready_for_review',
  'labeled'
])

/** Whether the given action may produce a notification under the toggles. */
export function shouldNotifyForAction(
  action: ReviewEvent['action'],
  kind: ReviewNotificationKind,
  toggles: ReviewNotificationEventToggles
): boolean {
  switch (action) {
    case 'opened':
      return kind === 'mr' ? toggles.mrOpened : toggles.issueOpened
    case 'reopened':
    case 'review_requested':
    case 'ready_for_review':
    case 'labeled':
      // Meaningful transitions on an MR/issue the user already knows about;
      // gated by the same opened toggle to keep the matrix small.
      return NOTIFY_ACTIONS.has(action) && (kind === 'mr' ? toggles.mrOpened : toggles.issueOpened)
    case 'updated':
      return kind === 'mr' ? toggles.mrUpdated : toggles.issueUpdated
    case 'merged':
      return kind === 'mr' ? toggles.mrMerged : false
    case 'closed':
      return kind === 'mr' ? toggles.mrClosed : false
  }
}

/**
 * Apply a transition to a base event (which carries action 'opened' from the
 * source) producing the classified event. Returns null when the transition
 * must stay silent.
 */
export function applyTransition(
  event: ReviewEvent,
  transition: Transition,
  kind: ReviewNotificationKind,
  toggles: ReviewNotificationEventToggles
): ReviewEvent | null {
  const next: ReviewEvent = { ...event, action: transition.action }
  if (!shouldNotifyForAction(next.action, kind, toggles)) {
    return null
  }
  return next
}
