import type { GitlabHook } from './forge-inbox-gitlab-hook-payload'

export const GITLAB_RELEVANCE_CATEGORIES = [
  'review-request',
  'participating-update',
  'pipeline-failure',
  'issue-mention',
  'issue-assignment'
] as const

export type GitlabRelevanceCategory = (typeof GITLAB_RELEVANCE_CATEGORIES)[number]

export type GitlabRelevance =
  | { relevance: 'relevant'; category: GitlabRelevanceCategory; passive: boolean }
  | { relevance: 'not-relevant'; passive: false }
  | { relevance: 'unknown'; passive: false }

export type GitlabProjectEvents = {
  reviewRequests: boolean
  participatingMergeRequestUpdates: boolean
  pipelineFailures: boolean
  issueMentions: boolean
  issueAssignments: boolean
}

const MAX_MENTION_SCAN_CHARS = 64 * 1024
const EVENT_TOGGLE: Record<GitlabRelevanceCategory, keyof GitlabProjectEvents> = {
  'review-request': 'reviewRequests',
  'participating-update': 'participatingMergeRequestUpdates',
  'pipeline-failure': 'pipelineFailures',
  'issue-mention': 'issueMentions',
  'issue-assignment': 'issueAssignments'
}

const NOT_RELEVANT: GitlabRelevance = { relevance: 'not-relevant', passive: false }
const UNKNOWN: GitlabRelevance = { relevance: 'unknown', passive: false }

/** Absent participation data is `unknown`, never a negative, so the API snapshot can decide. */
export function classifyGitlabHook(
  hook: GitlabHook,
  usernames: readonly string[],
  events: GitlabProjectEvents
): GitlabRelevance {
  const names = new Set(usernames.map(normalizeUsername))
  const isMe = (name: string | undefined) =>
    name !== undefined && names.has(normalizeUsername(name))
  const anyMe = (list: string[] | undefined) => list?.some(isMe) ?? false
  const mentioned = (text: string | undefined) => scanMentions(text, names)
  const relevant = (category: GitlabRelevanceCategory): GitlabRelevance => ({
    relevance: 'relevant',
    category,
    passive: !events[EVENT_TOGGLE[category]]
  })

  if (hook.kind === 'pipeline') {
    if (hook.status !== 'failed') {
      return NOT_RELEVANT
    }
    return isMe(hook.actor) ? relevant('pipeline-failure') : UNKNOWN
  }
  if (isMe(hook.actor)) {
    return NOT_RELEVANT
  }
  switch (hook.kind) {
    case 'merge_request':
      if (anyMe(hook.reviewers)) {
        return relevant('review-request')
      }
      if (anyMe(hook.assignees)) {
        return relevant('participating-update')
      }
      return hook.reviewers !== undefined && hook.assignees !== undefined ? NOT_RELEVANT : UNKNOWN
    case 'note':
      if (hook.system || mentioned(hook.noteText) !== 'mentioned') {
        return UNKNOWN
      }
      return relevant(hook.noteable === 'issue' ? 'issue-mention' : 'participating-update')
    case 'issue': {
      if (anyMe(hook.assignees)) {
        return relevant('issue-assignment')
      }
      const mention = mentioned(hook.description)
      if (mention === 'mentioned') {
        return relevant('issue-mention')
      }
      // Text past the scan bound is unread, so its silence is not a negative.
      return hook.assignees === undefined || mention === 'truncated' ? UNKNOWN : NOT_RELEVANT
    }
  }
}

/** One case-folding for both the actor check and mention matching so they can never disagree. */
function normalizeUsername(name: string): string {
  return name.toLowerCase()
}

const MENTION_PATTERN = /@([A-Za-z0-9._-]+)/g
const HANDLE_NEIGHBOR = /[\p{L}\p{N}_.@-]/u
const HANDLE_CONTINUATION = /[\p{L}\p{N}_]/u

function scanMentions(
  text: string | undefined,
  names: ReadonlySet<string>
): 'mentioned' | 'absent' | 'truncated' {
  if (text === undefined || names.size === 0) {
    return 'absent'
  }
  const truncated = text.length > MAX_MENTION_SCAN_CHARS
  const scanned = truncated ? text.slice(0, MAX_MENTION_SCAN_CHARS) : text
  for (const match of scanned.matchAll(MENTION_PATTERN)) {
    const before = scanned[match.index - 1]
    const end = match.index + match[0].length
    const after = scanned[end]
    const cutOff = truncated && end === scanned.length
    // Reject emails (bob@me), non-ASCII handle continuations (@bobé) and a handle the bound cut short.
    if (
      (before !== undefined && HANDLE_NEIGHBOR.test(before)) ||
      (after !== undefined && HANDLE_CONTINUATION.test(after)) ||
      cutOff
    ) {
      continue
    }
    if (names.has(normalizeUsername(match[1].replace(/[.-]+$/, '')))) {
      return 'mentioned'
    }
  }
  return truncated ? 'truncated' : 'absent'
}
