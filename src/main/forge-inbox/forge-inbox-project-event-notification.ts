import type { ForgeNotificationReason } from '../../shared/forge-inbox-notification-subject'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Only a category the reported facts prove: an unknown shape returns null so the action settles
 * blocked instead of inventing a notification the user did not ask for.
 */
export function projectEventNotificationCategory(
  facts: Record<string, unknown>
): ForgeNotificationReason | null {
  const kind = text(facts.kind)
  if (kind === 'pipeline') {
    return text(facts.status) === 'failed' ? 'pipeline-failure' : null
  }
  if (kind === 'merge_request') {
    const action = text(facts.action)
    if (action === 'open' || action === 'reopen') {
      return 'review-request'
    }
    return action === 'update' || action === 'approved' ? 'participating-update' : null
  }
  if (kind === 'issue') {
    const action = text(facts.action)
    return action === 'assigned' || action === 'assign' ? 'issue-assignment' : null
  }
  if (kind === 'push' || kind === 'tag_push' || kind === 'release' || kind === 'deployment') {
    return 'project-event'
  }
  if (kind === 'note') {
    const noteable = text(facts.noteableType)
    if (noteable === 'MergeRequest') {
      return 'participating-update'
    }
    return noteable === 'Issue' ? 'issue-mention' : null
  }
  return null
}
