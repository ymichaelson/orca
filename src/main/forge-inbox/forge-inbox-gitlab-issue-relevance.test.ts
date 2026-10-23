import { describe, expect, it } from 'vitest'
import { classifyGitlabSnapshot } from './forge-inbox-gitlab-snapshot-relevance'
import type { GitlabNote } from './forge-inbox-gitlab-api-schemas'

const EVENTS = {
  reviewRequests: true,
  participatingMergeRequestUpdates: true,
  pipelineFailures: true,
  issueMentions: true,
  issueAssignments: true
}
const note = (body: string, system = false): GitlabNote => ({
  id: 1,
  body,
  system,
  author: 'bob',
  updated_at: '2026-10-01T12:00:00.000Z'
})
const subject = (notes: GitlabNote[], notesComplete = true, description = '') => ({
  kind: 'issue' as const,
  issue: { iid: 3, state: 'opened', title: 'Bug', description, assignees: [] },
  notes,
  notesComplete
})

describe('verified issue relevance completeness', () => {
  it('finds API-only non-system mentions using the existing handle boundaries', () => {
    expect(classifyGitlabSnapshot(subject([note('cc @Me.')]), ['me'], EVENTS)).toMatchObject({
      relevance: 'relevant',
      category: 'issue-mention',
      passive: false
    })
    expect(
      classifyGitlabSnapshot(subject([note('cc @me')]), ['me'], { ...EVENTS, issueMentions: false })
    ).toMatchObject({ relevance: 'relevant', category: 'issue-mention', passive: true })
  })

  it('does not treat system text, email addresses or a note author as recipients', () => {
    const authorOnly = { ...note('no recipient'), author: 'me' }
    expect(
      classifyGitlabSnapshot(
        subject([note('cc @me', true), note('mail bob@me'), authorOnly]),
        ['me'],
        EVENTS
      )
    ).toEqual({ relevance: 'not-relevant', passive: false })
  })

  it('keeps a truncated notes no-match unknown rather than proving non-participation', () => {
    expect(classifyGitlabSnapshot(subject([note('cc @someone')], false), ['me'], EVENTS)).toEqual({
      relevance: 'unknown',
      passive: false
    })
  })

  it('keeps a note mention beyond the tokenizer scan bound unknown', () => {
    expect(
      classifyGitlabSnapshot(subject([note(`${' '.repeat(64 * 1024)}@me`)]), ['me'], EVENTS)
    ).toEqual({ relevance: 'unknown', passive: false })
  })

  it('keeps a truncated description unknown even if the fetched notes are complete', () => {
    expect(
      classifyGitlabSnapshot(subject([], true, `${' '.repeat(64 * 1024)}@me`), ['me'], EVENTS)
    ).toEqual({ relevance: 'unknown', passive: false })
  })

  it('accepts positive evidence even when other notes were truncated', () => {
    expect(classifyGitlabSnapshot(subject([note('cc @me')], false), ['me'], EVENTS)).toMatchObject({
      relevance: 'relevant',
      category: 'issue-mention',
      passive: false
    })
  })
})
