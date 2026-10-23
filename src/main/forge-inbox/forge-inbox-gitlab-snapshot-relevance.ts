import type { GitlabIssue, GitlabMergeRequest, GitlabNote } from './forge-inbox-gitlab-api-schemas'
import {
  classifyGitlabHook,
  type GitlabProjectEvents,
  type GitlabRelevance
} from './forge-inbox-gitlab-relevance'

export type GitlabSnapshotSubject =
  | { kind: 'merge_request'; mergeRequest: GitlabMergeRequest }
  | { kind: 'issue'; issue: GitlabIssue; notes: readonly GitlabNote[]; notesComplete: boolean }

const NOT_RELEVANT: GitlabRelevance = { relevance: 'not-relevant', passive: false }

/** A bounded no-match remains unknown when notes or mention scanning were truncated. */
export function classifyGitlabSnapshot(
  subject: GitlabSnapshotSubject,
  usernames: readonly string[],
  events: GitlabProjectEvents
): GitlabRelevance {
  if (subject.kind === 'issue') {
    const { issue, notes, notesComplete } = subject
    const hook = {
      kind: 'issue' as const,
      projectId: 0,
      iid: issue.iid,
      actor: undefined,
      action: undefined,
      state: undefined,
      description: issue.description,
      assignees: issue.assignees,
      reportedAt: undefined
    }
    const result = classifyGitlabHook(hook, usernames, events)
    if (result.relevance === 'relevant') {
      return result
    }
    let unknown = result.relevance === 'unknown' || !notesComplete
    for (const note of notes) {
      if (note.system) {
        continue
      }
      const mention = classifyGitlabHook({ ...hook, description: note.body }, usernames, events)
      if (mention.relevance === 'relevant') {
        return mention
      }
      unknown ||= mention.relevance === 'unknown'
    }
    return unknown ? { relevance: 'unknown', passive: false } : NOT_RELEVANT
  }
  const { mergeRequest } = subject
  const result = classifyGitlabHook(
    {
      kind: 'merge_request',
      projectId: 0,
      iid: mergeRequest.iid,
      actor: undefined,
      action: undefined,
      state: undefined,
      reviewers: mergeRequest.reviewers,
      assignees: mergeRequest.assignees,
      reportedSha: undefined,
      reportedAt: undefined
    },
    usernames,
    events
  )
  if (result.relevance === 'relevant') {
    return result
  }
  const author = mergeRequest.author.toLowerCase()
  return usernames.some((name) => name.toLowerCase() === author)
    ? {
        relevance: 'relevant',
        category: 'participating-update',
        passive: !events.participatingMergeRequestUpdates
      }
    : NOT_RELEVANT
}
