import { describe, expect, it } from 'vitest'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const SHA = '61f87cf496fbb2f460a4f0dce1d72c2499f3843c'
const BASE_URL = 'https://git.example.com/gitlab'

type Request = { url: string; init: RequestInit }

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
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

function commit(overrides: Record<string, unknown> = {}) {
  return {
    id: SHA,
    parent_ids: [],
    author_name: 'Orca',
    author_email: 'orca@example.com',
    authored_date: '2023-11-14T22:13:19.000+00:00',
    committer_name: 'Orca',
    committer_email: 'orca@example.com',
    committed_date: '2023-11-14T22:13:19.000+00:00',
    message: 'Base\n',
    ...overrides
  }
}

describe('gitlab commit read', () => {
  it('reads one commit by its pinned object id', async () => {
    const { reader, requests, script } = setup()
    script.push(json(commit()))

    const result = await reader.getRepositoryCommit(SHA)

    expect(result).toEqual({ ok: true, complete: true, data: commit() })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe(`/gitlab/api/v4/projects/42/repository/commits/${SHA}`)
    expect(requests[0]?.init.headers).toMatchObject({ 'PRIVATE-TOKEN': TOKEN })
  })

  it('refuses a branch name instead of a pinned commit without a request', async () => {
    const { reader, requests } = setup()

    await expect(reader.getRepositoryCommit('main')).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(requests).toEqual([])
  })

  it('refuses a commit answer without the fields the reconstruction needs', async () => {
    const { reader, script } = setup()
    script.push(json({ id: SHA }))

    await expect(reader.getRepositoryCommit(SHA)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('reports a missing commit and a failed request as failures', async () => {
    const { reader, script } = setup()
    script.push(new Response('{}', { status: 404 }))
    script.push(new Response('{}', { status: 500 }))

    await expect(reader.getRepositoryCommit(SHA)).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
    await expect(reader.getRepositoryCommit(SHA)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })
})
