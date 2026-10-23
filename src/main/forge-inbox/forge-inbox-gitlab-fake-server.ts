import { PROJECT_ID } from './forge-inbox-webhook-test-harness'

export const SHA_A = 'a'.repeat(40)
export const SHA_B = 'b'.repeat(40)

type FakeMergeRequest = {
  iid: number
  state: string
  title: string
  sha: string
  updated_at: string
  author: string
  reviewers: string[]
  assignees: string[]
}

type FakeNote = { id: number; body: string; author: string; system?: boolean }

const noHeadPipeline = (): Record<string, unknown> | null | undefined => undefined

const emptyNotes = (): FakeNote[] => []

const initialMergeRequest = (): FakeMergeRequest => ({
  iid: 7,
  state: 'opened',
  title: 'Add thing',
  sha: SHA_A,
  updated_at: '2026-10-01T12:00:00.000Z',
  author: 'alice',
  reviewers: ['me'],
  assignees: []
})

const named = (username: string) => ({ id: 1, username, name: username })

/** Serves official GitLab REST shapes from mutable state; every request is recorded. */
export function createFakeGitlab() {
  const requests: string[] = []
  const writes: { path: string; body: string; headers: Record<string, string> }[] = []
  const state = {
    mergeRequest: initialMergeRequest(),
    notes: emptyNotes(),
    issueNotes: emptyNotes(),
    diffsHaveMore: false,
    issue: { iid: 3, state: 'opened', title: 'Bug', description: '', assignees: ['me'] },
    pipeline: { id: 9, status: 'failed', sha: SHA_A, ref: 'main' },
    /** Official GET merge request shape: absent without CI visibility, null when none is attached. */
    headPipeline: noHeadPipeline(),
    /** Runs before each response so a test can change the world mid-snapshot. */
    onRequest: (_path: string, _count: number): void => {},
    override: (_path: string): Response | null => null
  }
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers }
    })

  async function fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const path = new URL(url).pathname.replace(/^.*\/api\/v4\/projects\/\d+/, '')
    requests.push(path)
    state.onRequest(path, requests.filter((seen) => seen === path).length)
    const forced = state.override(path)
    if (forced) {
      return forced
    }
    if ((init.method ?? 'GET') === 'POST') {
      const body = typeof init.body === 'string' ? init.body : ''
      writes.push({ path, body, headers: Object.fromEntries(new Headers(init.headers).entries()) })
      return createNote(path, body)
    }
    const mr = state.mergeRequest
    if (path === `/merge_requests/${mr.iid}`) {
      return json({
        ...mr,
        description: '',
        draft: false,
        target_branch: 'main',
        diff_refs: { base_sha: SHA_A, head_sha: mr.sha, start_sha: SHA_A },
        author: named(mr.author),
        reviewers: mr.reviewers.map(named),
        assignees: mr.assignees.map(named),
        ...(state.headPipeline === undefined ? {} : { head_pipeline: state.headPipeline })
      })
    }
    if (path === `/merge_requests/${mr.iid}/diffs`) {
      return json([{ old_path: 'a.ts', new_path: 'a.ts', diff: `@@ ${mr.sha}`, new_file: false }], {
        'x-next-page': state.diffsHaveMore ? '2' : ''
      })
    }
    if (path === `/merge_requests/${mr.iid}/notes`) {
      const newestFirst = state.notes
        .map((note) => ({
          ...note,
          system: note.system ?? false,
          author: named(note.author),
          updated_at: '2026-10-01T12:00:00.000Z'
        }))
        .toReversed()
      return json(newestFirst, { 'x-next-page': '' })
    }
    if (path === `/issues/${state.issue.iid}/notes`) {
      const newestFirst = state.issueNotes
        .map((note) => ({
          ...note,
          system: false,
          author: named(note.author),
          updated_at: '2026-10-01T12:00:00.000Z'
        }))
        .toReversed()
      return json(newestFirst, { 'x-next-page': '' })
    }
    if (path === `/issues/${state.issue.iid}`) {
      return json({ ...state.issue, assignees: state.issue.assignees.map(named) })
    }
    if (path === `/pipelines/${state.pipeline.id}`) {
      return json(state.pipeline)
    }
    return new Response('{"message":"404 Not found"}', { status: 404 })
  }

  /** Official create-note shape; the note joins the same list the reader later walks. */
  function createNote(path: string, raw: string): Response {
    const match = /^\/(merge_requests|issues)\/(\d+)\/notes$/.exec(path)
    if (!match) {
      return new Response('{"message":"404 Not found"}', { status: 404 })
    }
    let text = ''
    try {
      const parsed: unknown = JSON.parse(raw)
      const body = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'body') : ''
      text = typeof body === 'string' ? body : ''
    } catch {
      return new Response('{"message":"400 Bad request"}', { status: 400 })
    }
    const note = { id: 700 + writes.length, body: text, author: 'me' }
    if (match[1] === 'merge_requests' && Number(match[2]) === state.mergeRequest.iid) {
      state.notes.push(note)
    } else if (match[1] === 'issues' && Number(match[2]) === state.issue.iid) {
      state.issueNotes.push(note)
    } else {
      return new Response('{"message":"404 Not found"}', { status: 404 })
    }
    return new Response(
      JSON.stringify({
        ...note,
        system: false,
        author: named(note.author),
        created_at: '2026-10-01T12:00:00.000Z',
        updated_at: '2026-10-01T12:00:00.000Z'
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    )
  }
  return { state, requests, writes, fetch }
}

export type FakeGitlab = ReturnType<typeof createFakeGitlab>

const user = (username: string) => ({ id: 1, name: username, username })

export function mergeRequestHookBody(
  overrides: { actor?: string; sha?: string; reviewers?: string[]; assignees?: string[] } = {}
) {
  return {
    object_kind: 'merge_request',
    user: user(overrides.actor ?? 'alice'),
    project: { id: Number(PROJECT_ID) },
    object_attributes: {
      iid: 7,
      action: 'update',
      state: 'opened',
      last_commit: { id: overrides.sha ?? SHA_A },
      updated_at: '2026-10-01 12:00:00 UTC'
    },
    ...(overrides.reviewers ? { reviewers: overrides.reviewers.map(user) } : {}),
    ...(overrides.assignees ? { assignees: overrides.assignees.map(user) } : {})
  }
}

export const noteHookBody = (
  noteable: 'MergeRequest' | 'Issue',
  text: string,
  actor = 'alice'
) => ({
  object_kind: 'note',
  user: user(actor),
  project: { id: Number(PROJECT_ID) },
  object_attributes: { id: 501, note: text, noteable_type: noteable, system: false },
  ...(noteable === 'MergeRequest' ? { merge_request: { iid: 7 } } : { issue: { iid: 3 } })
})

export const pipelineHookBody = (
  status: string,
  options: { mergeRequest?: number; actor?: string } = {}
) => ({
  object_kind: 'pipeline',
  user: user(options.actor ?? 'alice'),
  project: { id: Number(PROJECT_ID) },
  object_attributes: { id: 9, status, ref: 'main', sha: SHA_A },
  ...(options.mergeRequest ? { merge_request: { iid: options.mergeRequest } } : {})
})

export const issueHookBody = (options: { assignees?: string[]; description?: string } = {}) => ({
  object_kind: 'issue',
  user: user('alice'),
  project: { id: Number(PROJECT_ID) },
  object_attributes: {
    iid: 3,
    action: 'update',
    state: 'opened',
    description: options.description
  },
  ...(options.assignees ? { assignees: options.assignees.map(user) } : {})
})
