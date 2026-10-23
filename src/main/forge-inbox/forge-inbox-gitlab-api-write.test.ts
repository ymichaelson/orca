import { describe, expect, it } from 'vitest'
import { createGitlabApiWriteRequester } from './forge-inbox-gitlab-api-request'

const TOKEN = 'glpat-SECRET-write-token'
const BASE = 'https://git.example.com/gitlab'

type Request = { url: string; init: RequestInit }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function setup(options: { token?: string | null; bumpOnFetch?: boolean } = {}) {
  const requests: Request[] = []
  const script: (Response | Error)[] = []
  let revision = 4
  const http = {
    fetch: async (url: string, init: RequestInit = {}): Promise<Response> => {
      requests.push({ url, init })
      if (options.bumpOnFetch) {
        revision += 1
      }
      const next = script.shift()
      if (next === undefined) {
        throw new Error('unscripted fetch')
      }
      if (next instanceof Error) {
        throw next
      }
      return next
    }
  }
  const write = createGitlabApiWriteRequester(
    {
      http,
      readToken: () => (options.token === undefined ? TOKEN : options.token),
      readConfigRevision: () => revision
    },
    { baseUrl: BASE, projectId: '42', expectedConfigRevision: 4 }
  )
  return { write, requests, script }
}

describe('gitlab api write requester', () => {
  it('posts JSON to the project-scoped notes path with the configured origin', async () => {
    const { write, requests, script } = setup()
    script.push(json({ id: 5, body: 'hi' }, 201))

    await expect(write.post('/merge_requests/7/notes', { body: 'hi' })).resolves.toMatchObject({
      ok: true
    })
    const sent = requests[0]
    if (sent === undefined) {
      throw new Error('no request recorded')
    }
    expect(sent.url).toBe(`${BASE}/api/v4/projects/42/merge_requests/7/notes`)
    expect(sent.init.method).toBe('POST')
    expect(sent.init.body).toBe('{"body":"hi"}')
    expect(sent.init.redirect).toBe('error')
    expect(sent.init.credentials).toBe('omit')
    const headers = new Headers(sent.init.headers)
    expect(headers.get('private-token')).toBe(TOKEN)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('never sends once the config revision moved', async () => {
    const requests: Request[] = []
    const write = createGitlabApiWriteRequester(
      {
        http: {
          fetch: async (url: string, init: RequestInit = {}) => {
            requests.push({ url, init })
            return json({})
          }
        },
        readToken: () => TOKEN,
        readConfigRevision: () => 5
      },
      { baseUrl: BASE, projectId: '42', expectedConfigRevision: 4 }
    )

    await expect(write.post('/issues/3/notes', { body: 'x' })).resolves.toEqual({
      ok: false,
      code: 'stale-config'
    })
    expect(requests).toHaveLength(0)
  })

  it('reports an unsendable token without making a request', async () => {
    const { write, requests } = setup({ token: 'has space' })

    await expect(write.post('/issues/3/notes', { body: 'x' })).resolves.toEqual({
      ok: false,
      code: 'no-credential'
    })
    expect(requests).toHaveLength(0)
  })

  it('maps a rejection to its status code without reading the body', async () => {
    const { write, script } = setup()
    script.push(new Response('{"message":"forbidden"}', { status: 403 }))

    await expect(write.post('/issues/3/notes', { body: 'x' })).resolves.toEqual({
      ok: false,
      code: 'forbidden'
    })
  })

  it('maps a transport failure to network', async () => {
    const { write, script } = setup()
    script.push(new Error('socket hang up'))

    await expect(write.post('/issues/3/notes', { body: 'x' })).resolves.toEqual({
      ok: false,
      code: 'network'
    })
  })

  it('keeps the created note id even when the config changed while the write was in flight', async () => {
    const { write, script } = setup({ bumpOnFetch: true })
    script.push(json({ id: 5 }, 201))

    await expect(write.post('/issues/3/notes', { body: 'x' })).resolves.toMatchObject({
      ok: true,
      json: { id: 5 }
    })
  })

  it('refuses an oversized request body without calling the forge', async () => {
    const { write, requests } = setup()

    await expect(write.post('/issues/3/notes', { body: 'x'.repeat(300 * 1024) })).resolves.toEqual({
      ok: false,
      code: 'request-too-large'
    })
    expect(requests).toHaveLength(0)
  })
})
