import { describe, expect, it } from 'vitest'
import { classifyGitlabSnapshot } from './forge-inbox-gitlab-snapshot-relevance'
import type { GitlabIssue, GitlabMergeRequest } from './forge-inbox-gitlab-api-schemas'

const EVENTS = {
  reviewRequests: true,
  participatingMergeRequestUpdates: true,
  pipelineFailures: true,
  issueMentions: true,
  issueAssignments: true
}

const mergeRequest = (overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest => ({
  iid: 7,
  state: 'opened',
  title: 'Add thing',
  description: '',
  target_branch: 'main',
  draft: false,
  sha: 'a'.repeat(40),
  diff_refs: null,
  author: 'alice',
  reviewers: [],
  assignees: [],
  updated_at: '2026-10-01T12:00:00.000Z',
  headPipeline: null,
  ...overrides
})

const classify = (snapshot: Parameters<typeof classifyGitlabSnapshot>[0], events = EVENTS) =>
  classifyGitlabSnapshot(snapshot, ['Me'], events)

describe('classifyGitlabSnapshot', () => {
  it('maps a reviewer, an assignee and the author of a merge request to categories', () => {
    expect(
      classify({ kind: 'merge_request', mergeRequest: mergeRequest({ reviewers: ['me'] }) })
    ).toEqual({ relevance: 'relevant', category: 'review-request', passive: false })
    expect(
      classify({ kind: 'merge_request', mergeRequest: mergeRequest({ assignees: ['ME'] }) })
    ).toEqual({ relevance: 'relevant', category: 'participating-update', passive: false })
    expect(
      classify({ kind: 'merge_request', mergeRequest: mergeRequest({ author: 'me' }) })
    ).toEqual({ relevance: 'relevant', category: 'participating-update', passive: false })
  })

  it('prefers review-request when the user is both author and reviewer', () => {
    expect(
      classify({
        kind: 'merge_request',
        mergeRequest: mergeRequest({ author: 'me', reviewers: ['me'] })
      })
    ).toMatchObject({ category: 'review-request' })
  })

  it('is definitively not relevant when nobody configured is involved, never unknown', () => {
    expect(
      classify({ kind: 'merge_request', mergeRequest: mergeRequest({ reviewers: ['bob'] }) })
    ).toEqual({ relevance: 'not-relevant', passive: false })
  })

  it('reports passive when the category toggle is off', () => {
    expect(
      classify(
        { kind: 'merge_request', mergeRequest: mergeRequest({ reviewers: ['me'] }) },
        { ...EVENTS, reviewRequests: false }
      )
    ).toMatchObject({ relevance: 'relevant', passive: true })
  })

  it('classifies an issue by assignee and by a mention in its description', () => {
    const issue = (overrides: Partial<GitlabIssue>): GitlabIssue => ({
      iid: 3,
      state: 'opened',
      title: 'Bug',
      description: '',
      assignees: [],
      ...overrides
    })
    expect(
      classify({
        kind: 'issue',
        issue: issue({ assignees: ['me'] }),
        notes: [],
        notesComplete: true
      })
    ).toMatchObject({
      category: 'issue-assignment'
    })
    expect(
      classify({
        kind: 'issue',
        issue: issue({ description: 'cc @me please' }),
        notes: [],
        notesComplete: true
      })
    ).toMatchObject({
      category: 'issue-mention'
    })
    expect(
      classify({
        kind: 'issue',
        issue: issue({ description: 'cc @someone' }),
        notes: [],
        notesComplete: true
      })
    ).toEqual({
      relevance: 'not-relevant',
      passive: false
    })
  })
})
