import type { ReviewNotificationEventToggles } from '../../shared/review-notification-types'
import type { ReviewWatermarkStore } from './dedup'
import { fingerprintReviewEvent, type ReviewEvent, type ReviewPollItem } from './review-event'
import {
  applyTransition,
  classifyTransition,
  type ItemSnapshot,
  type Transition
} from './transitions'

export type ReviewClassifyDeps = {
  /** Owns watermarks, fingerprints, and per-item snapshots (all persisted). */
  store: ReviewWatermarkStore
  now: () => number
}

export type ReviewClassifyInput = {
  provider: 'gitlab' | 'github'
  events: ReviewNotificationEventToggles
  watchedLabels: string[]
  /** Open items changed since the watermark. A delta: absence proves nothing. */
  listed: { mrs: ReviewEvent[]; issues: ReviewEvent[] }
  /**
   * Items confirmed closed/merged since the watermark (separate listing).
   * Only these may resolve an open notification — never the delta above.
   */
  closed: { mrs: ReviewEvent[]; issues: ReviewEvent[] }
}

function snapshotKey(event: ReviewEvent): string {
  return [
    event.provider,
    event.host.toLowerCase(),
    event.repo.toLowerCase(),
    event.kind,
    event.iid
  ].join('|')
}

function updatedToggleOn(kind: 'mr' | 'issue', events: ReviewNotificationEventToggles): boolean {
  return kind === 'mr' ? events.mrUpdated : events.issueUpdated
}

/**
 * Diff a poll snapshot against persisted last-seen state, producing
 * notify/update/resolve items. Fingerprint dedup and snapshots both survive
 * restarts, so a restart never re-notifies and never misclassifies a known
 * item as newly opened.
 */
export function classifyReviewItems(
  deps: ReviewClassifyDeps,
  input: ReviewClassifyInput
): ReviewPollItem[] {
  const { store, now } = deps
  const { provider, events, watchedLabels, listed, closed } = input
  const out: ReviewPollItem[] = []
  const handle = (event: ReviewEvent): void => {
    const key = snapshotKey(event)
    const prev = store.getSnapshot(key)
    const snapshot: ItemSnapshot = {
      iid: event.iid,
      updatedAt: event.updatedAt,
      draft: event.meta?.draft ?? prev?.draft ?? false,
      reviewers: event.meta?.reviewers ?? prev?.reviewers ?? [],
      labels: event.meta?.labels ?? prev?.labels ?? [],
      title: event.title
    }
    const transition: Transition = classifyTransition(prev, snapshot, watchedLabels)
    store.setSnapshot(key, snapshot)
    const classified = applyTransition(event, transition, event.kind, events)
    if (!classified) {
      // 'updated' refreshes in place when its toggle is on; silent otherwise.
      if (transition.action === 'updated' && updatedToggleOn(event.kind, events)) {
        out.push({ event: { ...event, action: 'updated' }, disposition: 'update' })
      }
      return
    }
    const fp = fingerprintReviewEvent(classified)
    if (store.hasFingerprint(fp)) {
      return
    }
    store.addFingerprint(fp)
    out.push({
      event: classified,
      disposition: classified.action === 'updated' ? 'update' : 'notify'
    })
  }
  for (const e of listed.mrs) {
    handle(e)
  }
  for (const e of listed.issues) {
    handle(e)
  }
  // Resolve only items the closed listing confirms as closed/merged. An item
  // merely absent from the delta listing (unchanged since the watermark) keeps
  // its snapshot and its notification.
  for (const e of [...closed.mrs, ...closed.issues]) {
    const key = snapshotKey(e)
    const snap = store.getSnapshot(key)
    if (!snap) {
      continue
    }
    out.push({
      event: {
        provider,
        host: e.host,
        repo: e.repo,
        kind: e.kind,
        action: 'closed',
        iid: e.iid,
        actor: '',
        title: snap.title,
        url: '',
        updatedAt: new Date(now()).toISOString()
      },
      disposition: 'resolve'
    })
    store.deleteSnapshot(key)
  }
  return out
}
