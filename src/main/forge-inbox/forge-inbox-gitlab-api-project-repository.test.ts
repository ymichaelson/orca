import { describe, expect, it } from 'vitest'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const BASE_URL = 'https://git.example.com/gitlab'
const HTTP_URL = 'https://git.example.com/gitlab/group/app.git'

type Request = { url: string; init: RequestInit }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function setup(options: { baseUrl?: string; projectId?: string } = {}) {
  const requests: Request[] = []
  const script: Response[] = []
  const reader = createGitlabApiReader(
    {
      http: {
        fetch: async (url: string, init: RequestInit = {}) => {
          requests.push({ url, init })
          const next = script.shift()
          if (next === undefined) {
            throw new Error('unscripted fetch')
          }
          return next
        }
      },
      readToken: () => TOKEN,
      readConfigRevision: () => 1
    },
    {
      baseUrl: options.baseUrl ?? BASE_URL,
      projectId: options.projectId ?? '42',
      expectedConfigRevision: 1
    }
  )
  return { reader, requests, script }
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    path_with_namespace: 'group/app',
    web_url: 'https://git.example.com/gitlab/group/app',
    http_url_to_repo: HTTP_URL,
    ...overrides
  }
}

describe('gitlab project repository read', () => {
  it('reads the configured project and returns its canonical HTTP clone URL', async () => {
    const { reader, requests, script } = setup()
    script.push(json(project()))

    const result = await reader.getProjectRepository()

    expect(result).toEqual({
      ok: true,
      complete: true,
      data: { projectId: 42, httpUrl: HTTP_URL }
    })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/gitlab/api/v4/projects/42')
    expect(url.search).toBe('')
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })
    expect(requests[0]?.init.headers).toEqual({
      'PRIVATE-TOKEN': TOKEN,
      Accept: 'application/json'
    })
  })

  it('accepts a project hosted at the instance root', async () => {
    const { reader, script } = setup({ baseUrl: 'https://git.example.com' })
    script.push(json(project({ http_url_to_repo: 'https://git.example.com/group/app.git' })))

    await expect(reader.getProjectRepository()).resolves.toEqual({
      ok: true,
      complete: true,
      data: { projectId: 42, httpUrl: 'https://git.example.com/group/app.git' }
    })
  })

  it.each(['', '0', '042', 'group/app', '42/other', '99999999999999999999'])(
    'refuses configured project id %j without a request',
    async (projectId) => {
      const { reader, requests } = setup({ projectId })

      await expect(reader.getProjectRepository()).resolves.toEqual({
        ok: false,
        code: 'bad-response'
      })
      expect(requests).toEqual([])
    }
  )

  it.each([
    ['a different numeric id', project({ id: 43 })],
    ['a string id', project({ id: '42' })],
    ['a fractional id', project({ id: 42.5 })],
    ['a missing id', { http_url_to_repo: HTTP_URL }],
    ['a missing clone URL', { id: 42 }],
    ['a non-string clone URL', project({ http_url_to_repo: null })]
  ])('refuses a response with %s', async (_case, body) => {
    const { reader, script } = setup()
    script.push(json(body))

    await expect(reader.getProjectRepository()).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it.each([
    ['another origin', 'https://evil.example/gitlab/group/app.git'],
    ['another base path', 'https://git.example.com/other/group/app.git'],
    ['a base-path prefix lookalike', 'https://git.example.com/gitlab-evil/group/app.git'],
    ['embedded credentials', 'https://user:pass@git.example.com/gitlab/group/app.git'],
    ['a query string', `${HTTP_URL}?redirect=https://evil.example`],
    ['a fragment', `${HTTP_URL}#fragment`],
    ['a non-HTTP scheme', 'ssh://git@git.example.com/gitlab/group/app.git'],
    ['a relative URL', '/gitlab/group/app.git'],
    ['the bare base path', 'https://git.example.com/gitlab/']
  ])('refuses a clone URL pointing at %s', async (_case, httpUrl) => {
    const { reader, script } = setup()
    script.push(json(project({ http_url_to_repo: httpUrl })))

    await expect(reader.getProjectRepository()).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('propagates project lookup failures', async () => {
    const { reader, script } = setup()
    script.push(json({ message: 'gone' }, { status: 404 }))
    script.push(json({ message: 'denied' }, { status: 403 }))

    await expect(reader.getProjectRepository()).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
    await expect(reader.getProjectRepository()).resolves.toEqual({
      ok: false,
      code: 'forbidden'
    })
  })
})
