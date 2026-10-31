import type {
  ForgeNotificationReason,
  ForgeNotificationTrigger
} from './forge-inbox-notification-subject'
import type { ForgeEventFacts } from './forge-inbox-types'

/**
 * What fired, from the facts the hook reported. An action nobody names refuses a notification: a
 * message that cannot say what happened would only be noise, and the event still reaches the inbox.
 */
export function forgeNotificationTrigger(
  facts: ForgeEventFacts | undefined
): ForgeNotificationTrigger | null {
  if (facts === undefined) {
    return null
  }
  if (facts.kind === undefined) {
    return null
  }
  switch (facts.kind) {
    case 'merge_request':
      return mergeRequestTriggers[facts.action ?? ''] ?? null
    case 'note':
      return 'note'
    case 'issue':
      if (facts.action === 'open' || facts.action === 'reopen') {
        return 'issue-opened'
      }
      return facts.action === 'close' ? 'issue-closed' : null
    case 'pipeline':
      return facts.status === 'failed' ? 'pipeline' : null
    case 'push':
      return 'push'
    case 'tag_push':
      return 'tag-push'
    case 'release':
      return 'release'
    case 'deployment':
      return 'deployment'
    default:
      return null
  }
}

const mergeRequestTriggers: Record<string, ForgeNotificationTrigger> = {
  open: 'merge-request-opened',
  reopen: 'merge-request-opened',
  approved: 'merge-request-approved',
  approval: 'merge-request-approved',
  merge: 'merge-request-merged',
  close: 'merge-request-closed'
}

/** One reason per trigger, so a reader can filter or mute what they care about. */
export function forgeNotificationReasonOf(
  trigger: ForgeNotificationTrigger
): ForgeNotificationReason {
  switch (trigger) {
    case 'merge-request-opened':
      return 'merge-request-opened'
    case 'merge-request-approved':
      return 'merge-request-approved'
    case 'merge-request-merged':
      return 'merge-request-merged'
    case 'merge-request-closed':
      return 'merge-request-closed'
    case 'note':
      return 'note-added'
    case 'issue-opened':
      return 'issue-opened'
    case 'issue-closed':
      return 'issue-closed'
    case 'pipeline':
      return 'pipeline-failure'
    case 'push':
      return 'push'
    case 'tag-push':
      return 'tag-push'
    case 'release':
      return 'release'
    case 'deployment':
      return 'deployment'
  }
}
