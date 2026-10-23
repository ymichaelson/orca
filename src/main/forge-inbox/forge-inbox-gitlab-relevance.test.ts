import { describe, expect, it } from 'vitest'
import type { GitlabHook } from './forge-inbox-gitlab-hook-payload'
import { classifyGitlabHook } from './forge-inbox-gitlab-relevance'

type Kind<K extends GitlabHook['kind']> = Extract<GitlabHook, { kind: K }>
type Events = Parameters<typeof classifyGitlabHook>[2]

const ME = ['Me']
const ALL_ON: Events = {
  reviewRequests: true,
  participatingMergeRequestUpdates: true,
  pipelineFailures: true,
  issueMentions: true,
  issueAssignments: true
}
const ALL_OFF: Events = {
  reviewRequests: false,
  participatingMergeRequestUpdates: false,
  pipelineFailures: false,
  issueMentions: false,
  issueAssignments: false
}

const mergeRequest = (overrides: Partial<Kind<'merge_request'>> = {}): Kind<'merge_request'> => ({
  kind: 'merge_request',
  projectId: 42,
  iid: 7,
  actor: 'alice',
  action: 'update',
  state: 'opened',
  reviewers: [],
  assignees: [],
  reportedSha: undefined,
  reportedAt: undefined,
  ...overrides
})

const note = (overrides: Partial<Kind<'note'>> = {}): Kind<'note'> => ({
  kind: 'note',
  noteable: 'merge_request',
  projectId: 42,
  iid: 7,
  actor: 'alice',
  noteId: 1,
  noteText: 'looks fine',
  system: false,
  reportedSha: undefined,
  reportedAt: undefined,
  ...overrides
})

const pipeline = (overrides: Partial<Kind<'pipeline'>> = {}): Kind<'pipeline'> => ({
  kind: 'pipeline',
  projectId: 42,
  pipelineId: 9,
  actor: 'alice',
  status: 'failed',
  ref: 'feature',
  mergeRequestIid: undefined,
  mergeRequestTargetProjectId: undefined,
  reportedSha: undefined,
  reportedAt: undefined,
  ...overrides
})

const issue = (overrides: Partial<Kind<'issue'>> = {}): Kind<'issue'> => ({
  kind: 'issue',
  projectId: 42,
  iid: 3,
  actor: 'alice',
  action: 'update',
  state: 'opened',
  description: 'plain',
  assignees: [],
  reportedAt: undefined,
  ...overrides
})

describe('classifyGitlabHook', () => {
  it('flags a review request when a configured user is a reviewer, case-insensitively', () => {
    expect(classifyGitlabHook(mergeRequest({ reviewers: ['ME'] }), ME, ALL_ON)).toEqual({
      relevance: 'relevant',
      category: 'review-request',
      passive: false
    })
  })

  it('flags a participating update when the user is only an assignee', () => {
    expect(classifyGitlabHook(mergeRequest({ assignees: ['me'] }), ME, ALL_ON)).toEqual({
      relevance: 'relevant',
      category: 'participating-update',
      passive: false
    })
  })

  it('is not relevant when participation is known and excludes the user', () => {
    expect(classifyGitlabHook(mergeRequest({ reviewers: ['bob'] }), ME, ALL_ON)).toEqual({
      relevance: 'not-relevant',
      passive: false
    })
  })

  it('is unknown, never not-relevant, when participation fields are absent', () => {
    const absent = mergeRequest({ reviewers: undefined, assignees: undefined })
    expect(classifyGitlabHook(absent, ME, ALL_ON)).toMatchObject({ relevance: 'unknown' })
    expect(classifyGitlabHook(note(), ME, ALL_ON)).toMatchObject({ relevance: 'unknown' })
    const onlyReviewersKnown = mergeRequest({ reviewers: ['bob'], assignees: undefined })
    expect(classifyGitlabHook(onlyReviewersKnown, ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })

  it('ignores the user own actions', () => {
    expect(
      classifyGitlabHook(mergeRequest({ actor: 'me', reviewers: ['me'] }), ME, ALL_ON)
    ).toMatchObject({ relevance: 'not-relevant' })
    expect(classifyGitlabHook(note({ actor: 'ME', noteText: 'cc @me' }), ME, ALL_ON)).toMatchObject(
      { relevance: 'not-relevant' }
    )
  })

  it('folds case the same way for a mention token and for the actor', () => {
    expect(classifyGitlabHook(note({ noteText: 'cc @ME' }), ['Me'], ALL_ON)).toMatchObject({
      relevance: 'relevant'
    })
  })

  it('matches a bounded @mention in a note but not a substring of another name', () => {
    expect(classifyGitlabHook(note({ noteText: 'hey @me, ptal' }), ME, ALL_ON)).toEqual({
      relevance: 'relevant',
      category: 'participating-update',
      passive: false
    })
    expect(classifyGitlabHook(note({ noteText: 'hey @melody' }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
    expect(classifyGitlabHook(note({ noteText: 'write to bob@me now' }), ME, ALL_ON)).toMatchObject(
      {
        relevance: 'unknown'
      }
    )
    expect(classifyGitlabHook(note({ noteText: 'mail@me.example' }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })

  it('matches usernames containing regex metacharacters literally', () => {
    expect(classifyGitlabHook(note({ noteText: 'cc @a.b' }), ['a.b'], ALL_ON)).toMatchObject({
      relevance: 'relevant'
    })
    expect(classifyGitlabHook(note({ noteText: 'cc @axb' }), ['a.b'], ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })

  it('keeps a relevant hook as passive history when its project toggle is off', () => {
    expect(
      classifyGitlabHook(mergeRequest({ reviewers: ['me'] }), ME, {
        ...ALL_ON,
        reviewRequests: false
      })
    ).toEqual({ relevance: 'relevant', category: 'review-request', passive: true })
    expect(classifyGitlabHook(issue({ assignees: ['me'] }), ME, ALL_OFF)).toEqual({
      relevance: 'relevant',
      category: 'issue-assignment',
      passive: true
    })
  })

  it('classifies failed pipelines triggered by the user, and ignores other statuses', () => {
    expect(classifyGitlabHook(pipeline({ actor: 'me' }), ME, ALL_ON)).toEqual({
      relevance: 'relevant',
      category: 'pipeline-failure',
      passive: false
    })
    expect(classifyGitlabHook(pipeline({ actor: 'me', status: 'success' }), ME, ALL_ON)).toEqual({
      relevance: 'not-relevant',
      passive: false
    })
    expect(classifyGitlabHook(pipeline({ actor: 'bob' }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })

  it('classifies issue assignment and description mentions', () => {
    expect(classifyGitlabHook(issue({ assignees: ['me'] }), ME, ALL_ON)).toMatchObject({
      relevance: 'relevant',
      category: 'issue-assignment'
    })
    expect(
      classifyGitlabHook(issue({ description: 'cc @me', assignees: ['bob'] }), ME, ALL_ON)
    ).toMatchObject({ relevance: 'relevant', category: 'issue-mention' })
    expect(classifyGitlabHook(issue({ assignees: ['bob'] }), ME, ALL_ON)).toEqual({
      relevance: 'not-relevant',
      passive: false
    })
    expect(classifyGitlabHook(issue({ assignees: undefined }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })

  it.each([
    ['review-request', mergeRequest({ reviewers: ['me'] }), 'reviewRequests'],
    [
      'participating-update',
      mergeRequest({ assignees: ['me'] }),
      'participatingMergeRequestUpdates'
    ],
    ['participating-update', note({ noteText: 'cc @me' }), 'participatingMergeRequestUpdates'],
    ['pipeline-failure', pipeline({ actor: 'me' }), 'pipelineFailures'],
    ['issue-mention', issue({ description: 'cc @me' }), 'issueMentions'],
    ['issue-mention', note({ noteable: 'issue', noteText: 'cc @me' }), 'issueMentions'],
    ['issue-assignment', issue({ assignees: ['me'] }), 'issueAssignments']
  ])('marks %s passive only when its own toggle is off', (category, hook, toggle) => {
    expect(classifyGitlabHook(hook, ME, ALL_ON)).toEqual({
      relevance: 'relevant',
      category,
      passive: false
    })
    expect(classifyGitlabHook(hook, ME, { ...ALL_ON, [toggle]: false })).toEqual({
      relevance: 'relevant',
      category,
      passive: true
    })
  })

  it('ignores an issue the user changed themselves', () => {
    expect(
      classifyGitlabHook(issue({ actor: 'ME', assignees: ['me'], description: '@me' }), ME, ALL_ON)
    ).toEqual({ relevance: 'not-relevant', passive: false })
  })

  it('matches any of several configured usernames', () => {
    const names = ['first', 'Second']
    expect(
      classifyGitlabHook(mergeRequest({ reviewers: ['SECOND'] }), names, ALL_ON)
    ).toMatchObject({
      category: 'review-request'
    })
    expect(classifyGitlabHook(note({ noteText: 'cc @first' }), names, ALL_ON)).toMatchObject({
      relevance: 'relevant'
    })
    expect(
      classifyGitlabHook(mergeRequest({ actor: 'first', reviewers: ['second'] }), names, ALL_ON)
    ).toMatchObject({ relevance: 'not-relevant' })
  })

  it('answers unknown, not not-relevant, when a mention may sit beyond the scanned text', () => {
    const long = `${'x'.repeat(64 * 1024)} cc @me`
    expect(classifyGitlabHook(note({ noteText: long }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
    expect(
      classifyGitlabHook(issue({ description: long, assignees: ['bob'] }), ME, ALL_ON)
    ).toMatchObject({ relevance: 'unknown' })
    expect(
      classifyGitlabHook(issue({ description: `@me ${long}`, assignees: ['bob'] }), ME, ALL_ON)
    ).toMatchObject({ relevance: 'relevant', category: 'issue-mention' })
  })

  it.each([
    ['trailing sentence period', 'thanks @me.', 'relevant'],
    ['trailing dash', 'thanks @me-', 'relevant'],
    ['a non-ASCII continuation', 'thanks @meé', 'unknown'],
    ['a non-ASCII letter before the at sign', 'écrire é@me', 'unknown'],
    ['a longer dotted handle', 'thanks @me.too', 'unknown'],
    ['start of text', '@me hi', 'relevant']
  ])('treats a note with %s deliberately', (_name, noteText, relevance) => {
    expect(classifyGitlabHook(note({ noteText }), ME, ALL_ON)).toMatchObject({ relevance })
  })

  it('reads a mention that ends exactly at the scan bound, but not a cut-off handle', () => {
    const padding = 'x '.repeat(32 * 1024 - 2)
    expect(`${padding} @me`).toHaveLength(64 * 1024)
    expect(classifyGitlabHook(note({ noteText: `${padding} @me` }), ME, ALL_ON)).toMatchObject({
      relevance: 'relevant'
    })
    const cut = `${padding} @me`
    expect(`${cut}lody`.length).toBeGreaterThan(64 * 1024)
    expect(classifyGitlabHook(note({ noteText: `${cut}lody` }), ME, ALL_ON)).toMatchObject({
      relevance: 'unknown'
    })
  })
})
