import { describe, expect, it } from 'vitest'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const REF = 'a'.repeat(40)
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

function entry(path: string, overrides: Record<string, unknown> = {}) {
  return { id: `id-${path}`, name: path, type: 'blob', path, mode: '100644', ...overrides }
}

describe('gitlab repository reads', () => {
  it('lists the recursive tree at the pinned commit', async () => {
    const { reader, requests, script } = setup()
    script.push(json([entry('src/a.ts')], { headers: { 'x-next-page': '' } }))

    const result = await reader.listRepositoryTree(REF)

    expect(result).toEqual({
      ok: true,
      complete: true,
      data: [entry('src/a.ts')]
    })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/gitlab/api/v4/projects/42/repository/tree')
    expect(url.searchParams.get('ref')).toBe(REF)
    expect(url.searchParams.get('recursive')).toBe('true')
    expect(url.searchParams.get('per_page')).toBe('100')
    expect(requests[0]?.init.headers).toMatchObject({ 'PRIVATE-TOKEN': TOKEN })
  })

  it('follows GitLab pages until the last one', async () => {
    const { reader, script } = setup()
    script.push(
      json([entry('a.ts')], { headers: { 'x-next-page': '2' } }),
      json([entry('b.ts')], { headers: { 'x-next-page': '' } })
    )

    const result = await reader.listRepositoryTree(REF)

    expect(result.ok && result.data.map((item) => item.path)).toEqual(['a.ts', 'b.ts'])
    expect(result.ok && result.complete).toBe(true)
  })

  it('reports an unusable page pointer as an incomplete tree', async () => {
    const { reader, script } = setup()
    script.push(json([entry('a.ts')], { headers: { 'x-next-page': 'nope' } }))

    await expect(reader.listRepositoryTree(REF)).resolves.toEqual({
      ok: true,
      complete: false,
      data: [entry('a.ts')]
    })
  })

  it('refuses a ref that is not a pinned commit', async () => {
    const { reader, requests } = setup()

    await expect(reader.listRepositoryTree('main')).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(requests).toEqual([])
  })

  it('refuses a malformed tree entry', async () => {
    const { reader, script } = setup()
    script.push(json([{ path: 'a.ts' }]))

    await expect(reader.listRepositoryTree(REF)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('reads raw file content at the pinned commit without JSON parsing', async () => {
    const { reader, requests, script } = setup()
    script.push(new Response('plain { not json\n', { status: 200 }))

    const result = await reader.getRepositoryFile(REF, 'src/a b.ts')

    expect(result).toEqual({ ok: true, data: 'plain { not json\n', complete: true })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/gitlab/api/v4/projects/42/repository/files/src%2Fa%20b.ts/raw')
    expect(url.searchParams.get('ref')).toBe(REF)
    expect(requests[0]?.init.headers).toMatchObject({ Accept: 'text/plain' })
  })

  it('maps a missing file and an invalid ref to failures without a request', async () => {
    const { reader, requests, script } = setup()
    script.push(new Response('{}', { status: 404 }))

    await expect(reader.getRepositoryFile(REF, 'gone.ts')).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
    await expect(reader.getRepositoryFile('main', 'gone.ts')).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(requests).toHaveLength(1)
  })
})
