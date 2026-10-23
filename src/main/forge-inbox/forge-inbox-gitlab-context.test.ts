import { describe, expect, it } from 'vitest'
import type {
  GitlabDiffFile,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNote,
  GitlabPipeline
} from './forge-inbox-gitlab-api-schemas'
import {
  buildIssueContext,
  buildMergeRequestContext,
  buildPipelineContext
} from './forge-inbox-gitlab-context'

const mergeRequest = (overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest => ({
  iid: 7,
  state: 'opened',
  title: 'Add thing',
  description: 'Explains the thing',
  target_branch: 'main',
  draft: false,
  sha: 'c0ffee',
  diff_refs: { base_sha: 'base1', head_sha: 'c0ffee', start_sha: 'start1' },
  author: 'alice',
  reviewers: ['bob'],
  assignees: ['carol'],
  updated_at: '2026-10-01T12:00:00Z',
  headPipeline: null,
  ...overrides
})

const note = (id: number, body = 'hello', overrides: Partial<GitlabNote> = {}): GitlabNote => ({
  id,
  system: false,
  author: 'dave',
  body,
  updated_at: '2026-10-01T12:00:00Z',
  ...overrides
})

const file = (path: string, diff = '@@ -1 +1 @@\n-a\n+b'): GitlabDiffFile => ({
  old_path: path,
  new_path: path,
  diff,
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  generated_file: false
})

const complete = { notes: true, diffs: true }

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    mergeRequest: mergeRequest(),
    notes: [note(1), note(2, 'second')],
    files: [file('a.ts'), file('b.ts')],
    completeness: complete,
    ...overrides
  }
}

describe('buildMergeRequestContext', () => {
  const token = (overrides: Record<string, unknown> = {}) =>
    buildMergeRequestContext(snapshot(overrides)).versionToken

  it('produces a stable sha256 token', () => {
    expect(token()).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(token()).toBe(token())
  })

  it('ignores ordering of notes, files, people and object keys', () => {
    const reordered = snapshot({
      mergeRequest: {
        updated_at: '2026-10-01T12:00:00Z',
        assignees: ['carol'],
        reviewers: ['bob'],
        author: 'alice',
        diff_refs: { start_sha: 'start1', head_sha: 'c0ffee', base_sha: 'base1' },
        sha: 'c0ffee',
        draft: false,
        title: 'Add thing',
        description: 'Explains the thing',
        target_branch: 'main',
        state: 'opened',
        iid: 7,
        headPipeline: null
      },
      notes: [note(2, 'second'), note(1)],
      files: [file('b.ts'), file('a.ts')]
    })
    expect(buildMergeRequestContext(reordered).versionToken).toBe(token())
    expect(token({ mergeRequest: mergeRequest({ reviewers: ['x', 'y'] }) })).toBe(
      token({ mergeRequest: mergeRequest({ reviewers: ['y', 'x'] }) })
    )
  })

  it('ignores updated_at churn on the merge request and on notes', () => {
    expect(
      token({
        mergeRequest: mergeRequest({ updated_at: '2027-01-01T00:00:00Z' }),
        notes: [note(1, 'hello', { updated_at: '2027-01-01T00:00:00Z' }), note(2, 'second')]
      })
    ).toBe(token())
  })

  it('changes with the head pipeline id or status and ignores everything else about CI', () => {
    const pipeline = { id: 1, status: 'failed', sha: 'c0ffee', ref: 'refs/merge-requests/7/head' }
    const withPipeline = (headPipeline: typeof pipeline | null) =>
      token({ mergeRequest: mergeRequest({ headPipeline }) })

    expect(withPipeline(pipeline)).not.toBe(withPipeline(null))
    expect(withPipeline(pipeline)).not.toBe(withPipeline({ ...pipeline, id: 2 }))
    expect(withPipeline(pipeline)).not.toBe(withPipeline({ ...pipeline, status: 'success' }))
    expect(withPipeline(pipeline)).toBe(withPipeline({ ...pipeline }))
  })

  it('changes when a note is added at the same head sha', () => {
    expect(token({ notes: [note(1), note(2, 'second'), note(3, 'new')] })).not.toBe(token())
  })

  it('changes when a note body is edited', () => {
    expect(token({ notes: [note(1), note(2, 'second, edited')] })).not.toBe(token())
  })

  it.each([
    [
      'head sha',
      { sha: 'beef', diff_refs: { base_sha: 'base1', head_sha: 'beef', start_sha: 'start1' } }
    ],
    ['base sha', { diff_refs: { base_sha: 'base2', head_sha: 'c0ffee', start_sha: 'start1' } }],
    ['start sha', { diff_refs: { base_sha: 'base1', head_sha: 'c0ffee', start_sha: 'start2' } }],
    ['state', { state: 'merged' }],
    ['draft flag', { draft: true }],
    ['title', { title: 'Renamed' }],
    ['iid', { iid: 8 }],
    ['description', { description: 'Explains something else' }],
    ['target branch', { target_branch: 'release' }],
    ['author', { author: 'mallory' }],
    ['reviewers', { reviewers: ['bob', 'erin'] }],
    ['assignees', { assignees: [] }]
  ])('changes when the %s changes', (_name, change) => {
    expect(token({ mergeRequest: mergeRequest(change) })).not.toBe(token())
  })

  it('changes when a file diff changes or a file is added', () => {
    expect(token({ files: [file('a.ts', 'other diff'), file('b.ts')] })).not.toBe(token())
    expect(token({ files: [file('a.ts'), file('b.ts'), file('c.ts')] })).not.toBe(token())
  })

  it('distinguishes a system note from a user note with the same text', () => {
    expect(token({ notes: [note(1), note(2, 'second', { system: true })] })).not.toBe(token())
  })

  it('differs between a complete and an incomplete snapshot of the same data', () => {
    const partial = buildMergeRequestContext(
      snapshot({ completeness: { notes: true, diffs: false } })
    )
    expect(partial.versionToken).not.toBe(token())
    expect(partial.completeness).toEqual({ notes: true, diffs: false, complete: false })
    expect(buildMergeRequestContext(snapshot()).completeness).toEqual({
      notes: true,
      diffs: true,
      complete: true
    })
  })

  it.each([
    ['old path', { old_path: 'old.ts' }],
    ['new file flag', { new_file: true }],
    ['renamed flag', { renamed_file: true }],
    ['deleted flag', { deleted_file: true }],
    ['generated flag', { generated_file: true }]
  ])('changes when a file %s changes', (_name, change) => {
    expect(token({ files: [{ ...file('a.ts'), ...change }, file('b.ts')] })).not.toBe(token())
  })

  it('orders files deterministically even when paths tie', () => {
    const renamedA = { ...file('same.ts', 'diff a'), old_path: 'old-a.ts' }
    const renamedB = { ...file('same.ts', 'diff b'), old_path: 'old-b.ts' }
    const sameOldPath = { ...file('same.ts', 'diff c'), old_path: 'old-a.ts' }
    expect(token({ files: [renamedA, renamedB, sameOldPath] })).toBe(
      token({ files: [sameOldPath, renamedB, renamedA] })
    )
  })

  it('changes when a note author changes', () => {
    expect(token({ notes: [note(1, 'hello', { author: 'mallory' }), note(2, 'second')] })).not.toBe(
      token()
    )
  })
})

describe('buildPipelineContext', () => {
  const pipeline = (overrides: Partial<GitlabPipeline> = {}): GitlabPipeline => ({
    id: 31,
    status: 'failed',
    sha: 'c0ffee',
    ref: 'feature',
    ...overrides
  })
  const token = (value: GitlabPipeline) => buildPipelineContext({ pipeline: value }).versionToken

  it('tracks status and sha, and is stable otherwise', () => {
    expect(token(pipeline())).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(token(pipeline())).toBe(token(pipeline()))
    expect(token(pipeline({ status: 'success' }))).not.toBe(token(pipeline()))
    expect(token(pipeline({ sha: 'beef' }))).not.toBe(token(pipeline()))
    expect(token(pipeline({ ref: 'other' }))).not.toBe(token(pipeline()))
    expect(token(pipeline({ id: 32 }))).not.toBe(token(pipeline()))
  })
})

describe('buildIssueContext', () => {
  const issue = (overrides: Partial<GitlabIssue> = {}): GitlabIssue => ({
    iid: 3,
    state: 'opened',
    title: 'Bug',
    description: 'Steps to reproduce',
    assignees: ['bob'],
    ...overrides
  })
  const token = (value: GitlabIssue, notes = [note(1)], notesComplete = true) =>
    buildIssueContext({ issue: value, notes, completeness: { notes: notesComplete } }).versionToken

  it('changes with state, assignees, notes and completeness, not with note timestamps', () => {
    const base = token(issue())
    expect(token(issue())).toBe(base)
    expect(token(issue({ state: 'closed' }))).not.toBe(base)
    expect(token(issue({ assignees: [] }))).not.toBe(base)
    expect(token(issue({ description: 'Different steps' }))).not.toBe(base)
    expect(token(issue({ title: 'Other bug' }))).not.toBe(base)
    expect(token(issue({ iid: 4 }))).not.toBe(base)
    expect(token(issue(), [note(1), note(2)])).not.toBe(base)
    expect(token(issue(), [note(1, 'hello', { updated_at: '2030-01-01T00:00:00Z' })])).toBe(base)
    expect(token(issue(), [note(1)], false)).not.toBe(base)
  })
})
