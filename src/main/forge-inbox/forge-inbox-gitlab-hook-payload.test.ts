import { describe, expect, it } from 'vitest'
import { parseGitlabHook } from './forge-inbox-gitlab-hook-payload'

const body = (value: unknown) => Buffer.from(JSON.stringify(value))
const user = (username: string) => ({ id: 1, name: username, username, email: '[REDACTED]' })

function mergeRequestHook(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: user('alice'),
    project: { id: 42, path_with_namespace: 'group/repo' },
    object_attributes: {
      id: 99,
      iid: 7,
      action: 'update',
      state: 'opened',
      draft: false,
      title: 'Add thing',
      last_commit: { id: 'c0ffee' },
      updated_at: '2026-10-01 12:00:00 UTC'
    },
    reviewers: [user('Bob')],
    assignees: [user('carol')],
    labels: [],
    changes: { updated_at: {} },
    ...overrides
  }
}

describe('parseGitlabHook', () => {
  it('extracts a merge request hook, ignoring unknown fields', () => {
    expect(parseGitlabHook('Merge Request Hook', body(mergeRequestHook()))).toEqual({
      ok: true,
      hook: {
        kind: 'merge_request',
        projectId: 42,
        iid: 7,
        actor: 'alice',
        action: 'update',
        state: 'opened',
        reviewers: ['Bob'],
        assignees: ['carol'],
        reportedSha: 'c0ffee',
        reportedAt: '2026-10-01 12:00:00 UTC'
      }
    })
  })

  it('reports absent participation arrays as undefined, and a present empty one as empty', () => {
    const { reviewers: _r, assignees: _a, ...bare } = mergeRequestHook()
    const absent = parseGitlabHook('Merge Request Hook', body(bare))
    expect(absent).toMatchObject({ ok: true, hook: { reviewers: undefined, assignees: undefined } })

    const empty = parseGitlabHook('Merge Request Hook', body({ ...bare, reviewers: [] }))
    expect(empty).toMatchObject({ ok: true, hook: { reviewers: [], assignees: undefined } })
  })

  it('extracts a merge request note with its text and no participation data', () => {
    const result = parseGitlabHook(
      'Note Hook',
      body({
        object_kind: 'note',
        user: user('dave'),
        project_id: 42,
        project: { id: 42 },
        object_attributes: {
          id: 1234,
          note: 'ping @Bob please look',
          noteable_type: 'MergeRequest',
          system: false,
          updated_at: '2026-10-01 12:05:00 UTC'
        },
        merge_request: { iid: 7, last_commit: { id: 'c0ffee' }, state: 'opened' }
      })
    )
    expect(result).toEqual({
      ok: true,
      hook: {
        kind: 'note',
        noteable: 'merge_request',
        projectId: 42,
        iid: 7,
        actor: 'dave',
        noteId: 1234,
        noteText: 'ping @Bob please look',
        system: false,
        reportedSha: 'c0ffee',
        reportedAt: '2026-10-01 12:05:00 UTC'
      }
    })
  })

  it('extracts an issue note from the embedded issue', () => {
    const result = parseGitlabHook(
      'Note Hook',
      body({
        object_kind: 'note',
        user: user('dave'),
        project: { id: 42 },
        object_attributes: { id: 5, note: 'hello', noteable_type: 'Issue', system: false },
        issue: { iid: 3, state: 'opened' }
      })
    )
    expect(result).toMatchObject({
      ok: true,
      hook: { kind: 'note', noteable: 'issue', iid: 3, projectId: 42 }
    })
  })

  it('treats a note on a commit or snippet as unsupported', () => {
    const result = parseGitlabHook(
      'Note Hook',
      body({
        object_kind: 'note',
        user: user('dave'),
        project: { id: 42 },
        object_attributes: { id: 5, note: 'x', noteable_type: 'Commit' }
      })
    )
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('extracts a pipeline hook', () => {
    const result = parseGitlabHook(
      'Pipeline Hook',
      body({
        object_kind: 'pipeline',
        user: user('alice'),
        project: { id: 42 },
        object_attributes: {
          id: 31,
          ref: 'feature',
          sha: 'c0ffee',
          status: 'failed',
          finished_at: '2026-10-01 12:10:00 UTC',
          created_at: '2026-10-01 12:00:00 UTC'
        },
        merge_request: { iid: 7 },
        builds: [{ id: 1, status: 'failed' }]
      })
    )
    expect(result).toEqual({
      ok: true,
      hook: {
        kind: 'pipeline',
        projectId: 42,
        pipelineId: 31,
        actor: 'alice',
        status: 'failed',
        ref: 'feature',
        mergeRequestIid: 7,
        reportedSha: 'c0ffee',
        reportedAt: '2026-10-01 12:10:00 UTC'
      }
    })
  })

  it('extracts an issue hook with description, assignees and state', () => {
    const result = parseGitlabHook(
      'Issue Hook',
      body({
        object_kind: 'issue',
        user: user('alice'),
        project: { id: 42 },
        object_attributes: {
          iid: 3,
          action: 'open',
          state: 'opened',
          description: 'cc @Bob',
          updated_at: '2026-10-01 12:00:00 UTC'
        },
        assignees: [user('bob')]
      })
    )
    expect(result).toEqual({
      ok: true,
      hook: {
        kind: 'issue',
        projectId: 42,
        iid: 3,
        actor: 'alice',
        action: 'open',
        state: 'opened',
        description: 'cc @Bob',
        assignees: ['bob'],
        reportedAt: '2026-10-01 12:00:00 UTC'
      }
    })
  })

  it('keeps a hook whose optional fields are missing', () => {
    const result = parseGitlabHook(
      'Merge Request Hook',
      body({
        object_kind: 'merge_request',
        project: { id: 42 },
        object_attributes: { iid: 7, action: 'open', state: 'opened' }
      })
    )
    expect(result).toEqual({
      ok: true,
      hook: {
        kind: 'merge_request',
        projectId: 42,
        iid: 7,
        actor: undefined,
        action: 'open',
        state: 'opened',
        reviewers: undefined,
        assignees: undefined,
        reportedSha: undefined,
        reportedAt: undefined
      }
    })
  })

  it('rejects event kinds it does not analyse', () => {
    expect(
      parseGitlabHook('Push Hook', body({ object_kind: 'push', project: { id: 42 } }))
    ).toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(parseGitlabHook('System Hook', body({}))).toEqual({ ok: false, reason: 'unsupported' })
  })

  it.each([
    ['invalid JSON', Buffer.from('{"object_kind":')],
    ['a JSON array', body([])],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['a missing project', body({ ...mergeRequestHook(), project: undefined })],
    ['a string project id', body({ ...mergeRequestHook(), project: { id: '42' } })],
    [
      'a non-integer iid',
      body(mergeRequestHook({ object_attributes: { iid: '7', action: 'open', state: 'opened' } }))
    ],
    [
      'an object_kind that contradicts the header',
      body({ ...mergeRequestHook(), object_kind: 'issue' })
    ],
    ['a reviewers field that is not a list', body(mergeRequestHook({ reviewers: 'bob' }))],
    ['a reviewer that is not an object', body(mergeRequestHook({ reviewers: ['bob'] }))],
    [
      'an iid beyond the safe integer range',
      body(
        mergeRequestHook({ object_attributes: { iid: 2 ** 60, action: 'open', state: 'opened' } })
      )
    ],
    ['a user that is not an object', body(mergeRequestHook({ user: 'alice' }))]
  ])('rejects %s as malformed', (_name, payload) => {
    expect(parseGitlabHook('Merge Request Hook', payload)).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it.each([
    ['Pipeline Hook', 'merge_request'],
    ['Issue Hook', 'merge_request'],
    ['Note Hook', 'issue'],
    ['Issue Hook', 'pipeline']
  ])('rejects a %s whose object_kind is the known kind %s as malformed', (header, kind) => {
    expect(parseGitlabHook(header, body({ ...mergeRequestHook(), object_kind: kind }))).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it.each([
    ['Issue Hook', 'work_item'],
    ['Merge Request Hook', 'something_new']
  ])('treats a %s with an unknown object_kind %s as unsupported', (header, kind) => {
    expect(
      parseGitlabHook(
        header,
        body({ object_kind: kind, project: { id: 42 }, object_attributes: { iid: 3 } })
      )
    ).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('requires an object_kind at all', () => {
    expect(
      parseGitlabHook('Issue Hook', body({ project: { id: 42 }, object_attributes: { iid: 3 } }))
    ).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a merge request note that carries no merge_request', () => {
    expect(
      parseGitlabHook(
        'Note Hook',
        body({
          object_kind: 'note',
          project: { id: 42 },
          object_attributes: { id: 5, note: 'x', noteable_type: 'MergeRequest' }
        })
      )
    ).toEqual({ ok: false, reason: 'malformed' })
  })

  it('treats a note on any other noteable type as unsupported', () => {
    expect(
      parseGitlabHook(
        'Note Hook',
        body({
          object_kind: 'note',
          project: { id: 42 },
          object_attributes: { id: 5, note: 'x', noteable_type: 'Epic' }
        })
      )
    ).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('accepts the confidential issue and note hook headers', () => {
    const issue = parseGitlabHook(
      'Confidential Issue Hook',
      body({
        object_kind: 'issue',
        project: { id: 42 },
        object_attributes: { iid: 3, action: 'open', state: 'opened' }
      })
    )
    expect(issue).toMatchObject({ ok: true, hook: { kind: 'issue', iid: 3 } })
    const note = parseGitlabHook(
      'Confidential Note Hook',
      body({
        object_kind: 'note',
        project: { id: 42 },
        object_attributes: { id: 5, note: 'x', noteable_type: 'Issue' },
        issue: { iid: 3 }
      })
    )
    expect(note).toMatchObject({ ok: true, hook: { kind: 'note', noteable: 'issue', iid: 3 } })
  })

  it('defaults a note without a system flag to a user note', () => {
    const result = parseGitlabHook(
      'Note Hook',
      body({
        object_kind: 'note',
        project: { id: 42 },
        object_attributes: { id: 5, note: 'x', noteable_type: 'Issue' },
        issue: { iid: 3 }
      })
    )
    expect(result).toMatchObject({ ok: true, hook: { system: false } })
  })

  it('skips a deleted ghost user without a username instead of rejecting the hook', () => {
    const result = parseGitlabHook(
      'Merge Request Hook',
      body(
        mergeRequestHook({
          user: { id: 1 },
          reviewers: [{ id: 3 }, user('bob')],
          assignees: [{ id: 4 }]
        })
      )
    )
    expect(result).toMatchObject({
      ok: true,
      hook: { actor: undefined, reviewers: ['bob'], assignees: [] }
    })
  })
})
