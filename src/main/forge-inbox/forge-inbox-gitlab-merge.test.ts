import { describe, expect, it } from 'vitest'
import { createGitlabMergePort } from './forge-inbox-gitlab-merge'

const SHA = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const BASE = 'https://git.example.com/gitlab'
const TARGET = {
  instanceId: 'instance-1',
  projectId: '42',
  kind: 'merge_request' as const,
  iid: 7
}

type Sent = { url: string; method: string; body: string | null }

function mergeRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    iid: 7,
    state: 'opened',
    title: 'Add docs',
    description: '',
    draft: false,
    sha: SHA,
    diff_refs: { base_sha: SHA, head_sha: SHA, start_sha: SHA },
    author: { username: 'ada' },
    reviewers: [],
    assignees: [],
    updated_at: '2026-10-30T00:00:00Z',
    head_pipeline: null,
    ...overrides
  }
}

function setup(responses: (Response | Error)[]) {
  const sent: Sent[] = []
  const http = {
    fetch: async (url: string, init: RequestInit = {}): Promise<Response> => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : null
      })
      const next = responses.shift()
      if (next === undefined) {
        throw new Error('unscripted fetch')
      }
      if (next instanceof Error) {
        throw next
      }
      return next
    }
  }
  const port = createGitlabMergePort({
    http,
    readWriteToken: () => 'write-token',
    readReadToken: () => 'read-token',
    readConfigRevision: () => 3,
    expectedConfigRevision: 3,
    resolveInstanceBaseUrl: () => BASE
  })
  return { port, sent }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const signal = new AbortController().signal

describe('gitlab merge port', () => {
  it('merges the reviewed head and sends that same sha as the guard', async () => {
    const { port, sent } = setup([json(mergeRequest()), json(mergeRequest({ state: 'merged' }))])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toEqual({ ok: true })
    expect(sent[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ sha: SHA }) })
    expect(sent[1]?.url).toBe(`${BASE}/api/v4/projects/42/merge_requests/7/merge`)
  })

  it('refuses before writing when the head moved after the review', async () => {
    const { port, sent } = setup([json(mergeRequest({ sha: MOVED }))])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toEqual({
      ok: false,
      code: 'head-moved',
      mayHaveLanded: false
    })
    expect(sent).toHaveLength(1)
  })

  it('refuses a draft merge request without writing', async () => {
    const { port, sent } = setup([json(mergeRequest({ draft: true }))])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toMatchObject({ code: 'draft' })
    expect(sent).toHaveLength(1)
  })

  it('reads a 409 on the write as a moved head that was never merged', async () => {
    const { port } = setup([json(mergeRequest()), json({ message: 'SHA mismatch' }, 409)])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toEqual({
      ok: false,
      code: 'head-moved',
      mayHaveLanded: false
    })
  })

  it('reads a 405 as GitLab refusing the merge, not as an unknown outcome', async () => {
    const { port } = setup([json(mergeRequest()), json({ message: 'not mergeable' }, 405)])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toEqual({
      ok: false,
      code: 'not-mergeable',
      mayHaveLanded: false
    })
  })

  it('keeps a lost write answer unknown rather than claiming nothing happened', async () => {
    const { port } = setup([json(mergeRequest()), new Error('socket hang up')])

    await expect(port.merge(TARGET, SHA, signal)).resolves.toEqual({
      ok: false,
      code: 'network',
      mayHaveLanded: true
    })
  })
})
