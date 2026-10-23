import { describe, expect, it } from 'vitest'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const SHA = 'a'.repeat(40)
const BASE_URL = 'https://git.example.com/gitlab'

type Request = { url: string; init: RequestInit }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function setup() {
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
    { baseUrl: BASE_URL, projectId: '42', expectedConfigRevision: 1 }
  )
  return { reader, requests, script }
}

function branch(name: string, id: string = SHA) {
  return {
    name,
    commit: { id, short_id: id.slice(0, 8), message: 'Topic' },
    merged: false,
    protected: false,
    default: false,
    web_url: 'https://git.example.com/e/evil'
  }
}

describe('gitlab branch head read', () => {
  it('reads one branch head by an encoded branch name under the configured project', async () => {
    const { reader, requests, script } = setup()
    script.push(json(branch('feature/deep/topic')))

    const result = await reader.getRepositoryBranchHead('feature/deep/topic')

    expect(result).toEqual({
      ok: true,
      complete: true,
      data: { branch: 'feature/deep/topic', sha: SHA }
    })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe(
      '/gitlab/api/v4/projects/42/repository/branches/feature%2Fdeep%2Ftopic'
    )
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

  it.each([
    '',
    '-main',
    '/main',
    'main/',
    'main..topic',
    'main//topic',
    'main.lock',
    'main?x',
    'main x',
    'main~1',
    'main^',
    'main:topic',
    'main*',
    'main[',
    'main\\topic',
    'main@{1}',
    '.hidden/topic'
  ])('refuses branch name %j without a request', async (name) => {
    const { reader, requests } = setup()

    await expect(reader.getRepositoryBranchHead(name)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(requests).toEqual([])
  })

  it.each([
    ['a different branch name', { name: 'other', commit: { id: SHA } }],
    ['a missing branch name', { commit: { id: SHA } }],
    ['a missing commit id', { name: 'main', commit: {} }],
    ['a short commit id', { name: 'main', commit: { id: 'a'.repeat(39) } }],
    ['an uppercase commit id', { name: 'main', commit: { id: 'A'.repeat(40) } }],
    ['a non-hex commit id', { name: 'main', commit: { id: `${'g'.repeat(39)}a` } }]
  ])('refuses a response with %s', async (_case, body) => {
    const { reader, script } = setup()
    script.push(json(body))

    await expect(reader.getRepositoryBranchHead('main')).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('propagates project and authorization failures', async () => {
    const { reader, script } = setup()
    script.push(json({ message: 'gone' }, { status: 404 }))
    script.push(json({ message: 'denied' }, { status: 403 }))

    await expect(reader.getRepositoryBranchHead('main')).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
    await expect(reader.getRepositoryBranchHead('main')).resolves.toEqual({
      ok: false,
      code: 'forbidden'
    })
  })
})
