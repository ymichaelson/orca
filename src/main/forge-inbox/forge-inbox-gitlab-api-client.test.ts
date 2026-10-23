import { describe, expect, it } from 'vitest'
import { createGitlabApiReader, type GitlabApiResult } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const MIB = 1024 * 1024
const PROJECT = '42'
const HOSTILE = 'https://evil.example/api/v4/projects/1/merge_requests/9/notes?page=2'

type Scripted = Response | Error | ((request: Request) => Response | Error)
type Request = { url: string; init: RequestInit }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function trackedBody(status: number, onCancel: () => void): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":"x"}'))
    },
    cancel: onCancel
  })
  return new Response(stream, { status })
}

function setup(
  options: { token?: string | null; baseUrl?: string; revision?: number; projectId?: string } = {}
) {
  const requests: Request[] = []
  const script: Scripted[] = []
  let revision = options.revision ?? 4
  const http = {
    fetch: async (url: string, init: RequestInit = {}): Promise<Response> => {
      requests.push({ url, init })
      const next = script.shift()
      if (next === undefined) {
        throw new Error('unscripted fetch')
      }
      const outcome = typeof next === 'function' ? next({ url, init }) : next
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }
  }
  const reader = createGitlabApiReader(
    {
      http,
      readToken: () => (options.token === undefined ? TOKEN : options.token),
      readConfigRevision: () => revision
    },
    {
      baseUrl: options.baseUrl ?? 'https://git.example.com/gitlab',
      projectId: options.projectId ?? PROJECT,
      expectedConfigRevision: options.revision ?? 4
    }
  )
  return { reader, requests, script, bumpRevision: () => (revision += 1) }
}

function failureText(result: GitlabApiResult<unknown>): string {
  return JSON.stringify(result)
}

const mergeRequest = {
  id: 9001,
  iid: 7,
  state: 'opened',
  title: 'Fix it',
  draft: false,
  sha: 'a'.repeat(40),
  web_url: HOSTILE,
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40), start_sha: 'd'.repeat(40) },
  author: { id: 1, username: 'alice', name: 'Alice' },
  reviewers: [{ username: 'bob' }],
  assignees: [{ username: 'carol' }],
  updated_at: '2026-10-01T10:00:00.000Z',
  description: 'Explains the fix',
  target_branch: 'main'
}

function note(id: number) {
  return {
    id,
    system: false,
    author: { username: 'alice' },
    body: `note ${id}`,
    updated_at: '2026-10-01T10:00:00.000Z',
    noteable_type: 'MergeRequest'
  }
}

function notesPage(ids: number[], nextPage: string | null, extra: Record<string, string> = {}) {
  return json(ids.map(note), {
    headers: {
      'content-type': 'application/json',
      ...(nextPage ? { 'x-next-page': nextPage } : {}),
      ...extra
    }
  })
}

describe('forge inbox GitLab read client', () => {
  it('sends a locked-down GET under the configured base path with only the api-read token', async () => {
    const { reader, requests, script } = setup()
    script.push(json(mergeRequest))

    const result = await reader.getMergeRequest(7)

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(
      'https://git.example.com/gitlab/api/v4/projects/42/merge_requests/7'
    )
    expect(requests[0].init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })
    expect(requests[0].init.headers).toEqual({ 'PRIVATE-TOKEN': TOKEN, Accept: 'application/json' })
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      ok: true,
      complete: true,
      data: {
        iid: 7,
        state: 'opened',
        title: 'Fix it',
        description: 'Explains the fix',
        target_branch: 'main',
        source_branch: null,
        source_project_id: null,
        target_project_id: null,
        draft: false,
        sha: 'a'.repeat(40),
        diff_refs: mergeRequest.diff_refs,
        author: 'alice',
        reviewers: ['bob'],
        assignees: ['carol'],
        updated_at: '2026-10-01T10:00:00.000Z',
        headPipeline: null
      }
    })
  })

  it('percent-encodes a path-style project id (defense in depth; config only allows numeric ids)', async () => {
    const { reader, requests, script } = setup({ projectId: 'group/sub project' })
    script.push(json(mergeRequest))

    await reader.getMergeRequest(7)

    expect(requests[0].url).toBe(
      'https://git.example.com/gitlab/api/v4/projects/group%2Fsub%20project/merge_requests/7'
    )
  })

  it('extracts only the needed pipeline and issue fields', async () => {
    const { reader, requests, script } = setup()
    script.push(
      json({
        id: 55,
        status: 'success',
        sha: 'e'.repeat(40),
        ref: 'main',
        web_url: HOSTILE,
        user: {}
      }),
      json({
        iid: 3,
        state: 'closed',
        title: 'Bug',
        assignees: [{ username: 'dave' }],
        description: 'Steps',
        labels: ['not-requested']
      })
    )

    const pipeline = await reader.getPipeline(55)
    const issue = await reader.getIssue(3)

    expect(requests.map((r) => r.url)).toEqual([
      'https://git.example.com/gitlab/api/v4/projects/42/pipelines/55',
      'https://git.example.com/gitlab/api/v4/projects/42/issues/3'
    ])
    expect(pipeline).toEqual({
      ok: true,
      complete: true,
      data: { id: 55, status: 'success', sha: 'e'.repeat(40), ref: 'main' }
    })
    expect(issue).toEqual({
      ok: true,
      complete: true,
      data: { iid: 3, state: 'closed', title: 'Bug', description: 'Steps', assignees: ['dave'] }
    })
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'bad-response']
  ] as const)(
    'classifies HTTP %i as %s without leaking token, URL or body',
    async (status, code) => {
      const { reader, script } = setup()
      script.push(
        json({ message: `denied for ${TOKEN} at https://git.example.com/secret` }, { status })
      )

      const result = await reader.getMergeRequest(7)

      expect(result).toMatchObject({ ok: false, code })
      const text = failureText(result)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('git.example.com')
      expect(text).not.toContain('denied')
    }
  )

  it('reports rate limiting with a clamped Retry-After', async () => {
    const { reader, script } = setup()
    script.push(
      json({}, { status: 429, headers: { 'retry-after': '30' } }),
      json({}, { status: 429, headers: { 'retry-after': '999999' } }),
      json({}, { status: 429, headers: { 'retry-after': 'soon' } }),
      json({}, { status: 429, headers: { 'retry-after': '0' } })
    )

    const normal = await reader.getIssue(1)
    const huge = await reader.getIssue(1)
    const junk = await reader.getIssue(1)
    const zero = await reader.getIssue(1)

    expect(normal).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 30_000 })
    expect(huge).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 300_000 })
    expect(junk).toEqual({ ok: false, code: 'rate-limited' })
    expect(zero).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 1000 })
  })

  it('cancels unread response bodies on non-ok statuses', async () => {
    const { reader, script } = setup()
    let cancelled = 0
    for (const status of [401, 404, 429, 500]) {
      script.push(trackedBody(status, () => (cancelled += 1)))
    }

    for (let i = 0; i < 4; i += 1) {
      await reader.getIssue(1)
    }

    expect(cancelled).toBe(4)
  })

  it.each(['bad\r\ntoken', 'tök\u00e9n', 'with space', ''])(
    'treats an unsendable token %j as no credential without fetching',
    async (token) => {
      const { reader, requests } = setup({ token })

      expect(await reader.getIssue(1)).toEqual({ ok: false, code: 'no-credential' })
      expect(requests).toEqual([])
    }
  )

  it('normalizes null or missing optional merge request fields', async () => {
    const { reader, script } = setup()
    const { draft: _draft, diff_refs: _refs, ...rest } = mergeRequest
    script.push(
      json({ ...rest, reviewers: null, assignees: null, work_in_progress: true }),
      json({ ...mergeRequest, diff_refs: null, draft: undefined })
    )

    const legacy = await reader.getMergeRequest(7)
    const bare = await reader.getMergeRequest(7)

    expect(legacy.ok && legacy.data).toMatchObject({
      draft: true,
      reviewers: [],
      assignees: [],
      diff_refs: null
    })
    expect(bare.ok && bare.data).toMatchObject({ draft: false, diff_refs: null })
  })

  it('keeps the source branch and project ids used to resolve a fork target', async () => {
    const { reader, script } = setup()
    script.push(
      json({
        ...mergeRequest,
        source_branch: 'feature/topic',
        source_project_id: 41,
        target_project_id: 42
      }),
      json({
        ...mergeRequest,
        source_branch: null,
        source_project_id: null,
        target_project_id: null
      })
    )

    const fork = await reader.getMergeRequest(7)
    const nulled = await reader.getMergeRequest(7)

    expect(fork.ok && fork.data).toMatchObject({
      source_branch: 'feature/topic',
      source_project_id: 41,
      target_project_id: 42
    })
    expect(nulled.ok && nulled.data).toMatchObject({
      source_branch: null,
      source_project_id: null,
      target_project_id: null
    })
  })

  it('accepts null assignees on issues', async () => {
    const { reader, script } = setup()
    script.push(json({ iid: 3, state: 'opened', title: 'T', assignees: null }))

    const result = await reader.getIssue(3)

    expect(result.ok && result.data.assignees).toEqual([])
  })

  it('does not fetch without an api-read credential', async () => {
    const { reader, requests } = setup({ token: null })

    const results = [
      await reader.getMergeRequest(7),
      await reader.listMergeRequestNotes(7),
      await reader.getMergeRequestDiffs(7)
    ]

    expect(results.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'no-credential',
      'no-credential',
      'no-credential'
    ])
    expect(requests).toEqual([])
  })

  it.each([0, -1, 1.5, Number.NaN, 2 ** 60])('rejects iid %s before any request', async (iid) => {
    const { reader, requests } = setup()

    const result = await reader.getMergeRequest(iid)

    expect(result).toMatchObject({ ok: false, code: 'bad-response' })
    expect(requests).toEqual([])
  })

  it('rejects a malformed payload as a bad response', async () => {
    const { reader, script } = setup()
    script.push(json({ ...mergeRequest, iid: 'seven' }))

    expect(await reader.getMergeRequest(7)).toMatchObject({ ok: false, code: 'bad-response' })
  })

  it('does not follow redirects and hides transport error details', async () => {
    const { reader, requests, script } = setup()
    script.push(new TypeError(`fetch failed for https://git.example.com?token=${TOKEN}`))
    script.push(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
    )

    const thrown = await reader.getMergeRequest(7)
    const redirected = await reader.getMergeRequest(7)

    expect(thrown).toMatchObject({ ok: false, code: 'network' })
    expect(failureText(thrown)).not.toContain(TOKEN)
    expect(failureText(thrown)).not.toContain('git.example.com')
    expect(redirected).toMatchObject({ ok: false, code: 'bad-response' })
    expect(requests.every((r) => r.url.startsWith('https://git.example.com/gitlab/api/v4/'))).toBe(
      true
    )
  })

  it('maps a body over the response cap to too-large', async () => {
    const { reader, script } = setup()
    script.push(json({ ...mergeRequest, title: 'x'.repeat(3 * MIB) }))

    expect(await reader.getMergeRequest(7)).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('reports stale-config when the revision moves during a request', async () => {
    const harness = setup()
    harness.script.push(() => {
      harness.bumpRevision()
      return json(mergeRequest)
    })

    const result = await harness.reader.getMergeRequest(7)

    expect(result).toEqual({ ok: false, code: 'stale-config' })
  })

  it('reports stale-config before the first request when the scope is already outdated', async () => {
    const harness = setup()
    harness.bumpRevision()

    expect(await harness.reader.getIssue(1)).toEqual({ ok: false, code: 'stale-config' })
    expect(harness.requests).toEqual([])
  })

  describe('body read failures', () => {
    const failingBody = (error: unknown) =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.error(error)
            }
          },
          { highWaterMark: 0 }
        ),
        { status: 200 }
      )

    it.each([
      ['timeout', new DOMException('timed out', 'TimeoutError')],
      ['abort', new DOMException('aborted', 'AbortError')],
      ['connection reset', new TypeError('terminated')]
    ])('maps a %s while reading the body to network', async (_name, error) => {
      const { reader, script } = setup()
      script.push(failingBody(error))

      expect(await reader.getIssue(1)).toEqual({ ok: false, code: 'network' })
    })

    it('keeps a malformed JSON body as bad-response', async () => {
      const { reader, script } = setup()
      script.push(new Response('{"iid":', { status: 200 }))

      expect(await reader.getIssue(1)).toEqual({ ok: false, code: 'bad-response' })
    })

    it('reports stale-config when the revision moves while the body streams', async () => {
      const harness = setup()
      harness.script.push(() => {
        const bytes = new TextEncoder().encode(JSON.stringify(mergeRequest))
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                harness.bumpRevision()
                controller.enqueue(bytes)
                controller.close()
              }
            },
            { highWaterMark: 0 }
          ),
          { status: 200 }
        )
      })

      expect(await harness.reader.getMergeRequest(7)).toEqual({ ok: false, code: 'stale-config' })
    })
  })

  describe('merge request notes pagination', () => {
    it('collects every page and is complete when x-next-page is empty', async () => {
      const { reader, requests, script } = setup()
      script.push(notesPage([3, 2], '2'), notesPage([1], ''))

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: true })
      expect(result.ok && result.data.map((n) => n.id)).toEqual([1, 2, 3])
      const urls = requests.map((r) => new URL(r.url))
      expect(urls.map((u) => u.pathname)).toEqual(
        Array(2).fill('/gitlab/api/v4/projects/42/merge_requests/7/notes')
      )
      expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2'])
      expect(urls[0].searchParams.get('per_page')).toBe('100')
      expect(urls[0].searchParams.get('sort')).toBe('desc')
    })

    it('reads issue notes newest-first from the issues route and returns them chronologically', async () => {
      const { reader, requests, script } = setup()
      script.push(notesPage([2, 1], ''))

      const result = await reader.listIssueNotes(3)

      expect(result.ok && result.data.map((n) => n.id)).toEqual([1, 2])
      const url = new URL(requests[0].url)
      expect(url.pathname).toBe('/gitlab/api/v4/projects/42/issues/3/notes')
      expect(url.searchParams.get('sort')).toBe('desc')
      expect(await reader.listIssueNotes(0)).toEqual({ ok: false, code: 'bad-response' })
    })

    it('stops at five pages and marks the result incomplete', async () => {
      const { reader, requests, script } = setup()
      for (let page = 1; page <= 6; page += 1) {
        script.push(notesPage([100 - page], String(page + 1)))
      }

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data.map((n) => n.id)).toEqual([95, 96, 97, 98, 99])
      expect(requests).toHaveLength(5)
    })

    it.each([
      ['repeats the current page', ['2', '2']],
      ['goes backwards', ['2', '1']],
      ['is not an integer', ['abc']],
      ['is zero', ['0']],
      ['is fractional', ['1.5']],
      ['is negative', ['-4']],
      ['is an absolute URL', [HOSTILE]]
    ])('stops without looping when x-next-page %s', async (_name, pages) => {
      const { reader, requests, script } = setup()
      pages.forEach((next, index) => script.push(notesPage([index + 1], next)))
      script.push(notesPage([99], ''))

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data.map((n) => n.id)).not.toContain(99)
      expect(requests.length).toBeLessThanOrEqual(pages.length)
    })

    it('never requests URLs taken from Link headers or payloads', async () => {
      const { reader, requests, script } = setup()
      script.push(notesPage([1], '2', { link: `<${HOSTILE}>; rel="next"` }), notesPage([2], ''))

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: true })
      expect(requests).toHaveLength(2)
      expect(
        requests.every((r) => r.url.startsWith('https://git.example.com/gitlab/api/v4/'))
      ).toBe(true)
    })

    it('stops at the total byte budget and marks the result incomplete', async () => {
      const { reader, script } = setup()
      const big = (id: number) => ({ ...note(id), body: 'y'.repeat(900 * 1024) })
      for (let page = 1; page <= 3; page += 1) {
        script.push(json([big(page)], { headers: { 'x-next-page': String(page + 1) } }))
      }

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data.length).toBeLessThan(3)
    })

    it('reports stale-config when the revision moves between pages', async () => {
      const harness = setup()
      harness.script.push(() => {
        harness.bumpRevision()
        return notesPage([1], '2')
      })

      expect(await harness.reader.listMergeRequestNotes(7)).toEqual({
        ok: false,
        code: 'stale-config'
      })
      expect(harness.requests).toHaveLength(1)
    })

    it('returns the error, not partial data, when a later page fails', async () => {
      const { reader, requests, script } = setup()
      script.push(notesPage([1], '2'), json({}, { status: 403 }), notesPage([3], ''))

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toEqual({ ok: false, code: 'forbidden' })
      expect(requests).toHaveLength(2)
    })

    it('treats a missing x-next-page on a full page as incomplete', async () => {
      const { reader, script } = setup()
      script.push(
        notesPage(
          Array.from({ length: 100 }, (_, i) => i + 1),
          null
        )
      )

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data).toHaveLength(100)
    })

    it('counts the notes budget in UTF-8 bytes, not characters', async () => {
      const { reader, script } = setup()
      const wide = (id: number) => ({ ...note(id), body: '\u20ac'.repeat(400_000) })
      script.push(
        json([wide(1)], { headers: { 'x-next-page': '2' } }),
        json([wide(2)], { headers: { 'x-next-page': '3' } })
      )

      const result = await reader.listMergeRequestNotes(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data.map((n) => n.id)).toEqual([1])
    })

    it('keeps system notes flagged and ignores unknown note fields', async () => {
      const { reader, script } = setup()
      script.push(json([{ ...note(1), system: true }], {}))

      const result = await reader.listMergeRequestNotes(7)

      expect(result.ok && result.data).toEqual([
        {
          id: 1,
          system: true,
          author: 'alice',
          body: 'note 1',
          updated_at: '2026-10-01T10:00:00.000Z'
        }
      ])
    })
  })

  describe('merge request diffs', () => {
    const file = (n: number, diff = '@@ -1 +1 @@\n-a\n+b\n') => ({
      old_path: `old${n}.ts`,
      new_path: `new${n}.ts`,
      diff,
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      generated_file: false
    })

    it('requests the paginated diffs endpoint and returns the files', async () => {
      const { reader, requests, script } = setup()
      script.push(json([file(1), file(2)]))

      const result = await reader.getMergeRequestDiffs(7)

      expect(new URL(requests[0].url).pathname).toBe(
        '/gitlab/api/v4/projects/42/merge_requests/7/diffs'
      )
      expect(new URL(requests[0].url).searchParams.get('per_page')).toBe('100')
      expect(result).toMatchObject({ ok: true, complete: true })
      expect(result.ok && result.data.map((f) => f.new_path)).toEqual(['new1.ts', 'new2.ts'])
    })

    it('caps at 100 files and marks the result incomplete', async () => {
      const { reader, script } = setup()
      const files = Array.from({ length: 100 }, (_, i) => file(i))
      script.push(json(files, { headers: { 'x-next-page': '2' } }))
      script.push(json([file(1000)]))

      const result = await reader.getMergeRequestDiffs(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data).toHaveLength(100)
    })

    it('counts the diff budget in UTF-8 bytes, not characters', async () => {
      const { reader, script } = setup()
      const diff = '\u20ac'.repeat(200_000)
      script.push(json([file(1, diff), file(2, diff)]))

      const result = await reader.getMergeRequestDiffs(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      expect(result.ok && result.data).toHaveLength(1)
    })

    it('caps decoded diff text at 1 MiB and marks the result incomplete', async () => {
      const { reader, script } = setup()
      const diff = 'z'.repeat(400 * 1024)
      script.push(json([file(1, diff), file(2, diff), file(3, diff)]))

      const result = await reader.getMergeRequestDiffs(7)

      expect(result).toMatchObject({ ok: true, complete: false })
      const total = result.ok ? result.data.reduce((sum, f) => sum + f.diff.length, 0) : Infinity
      expect(total).toBeLessThanOrEqual(MIB)
      expect(result.ok && result.data.length).toBeGreaterThan(0)
    })
  })
})
