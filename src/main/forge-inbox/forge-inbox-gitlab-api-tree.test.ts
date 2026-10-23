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
  let revision = 1
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
      readConfigRevision: () => revision
    },
    { baseUrl: BASE_URL, projectId: '42', expectedConfigRevision: 1 }
  )
  return { reader, requests, script, bumpRevision: () => (revision += 1) }
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

  it.each([
    ['a stray continuation byte', [0x80]],
    ['an overlong sequence', [0xc0, 0xaf]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a truncated sequence', [0xe2, 0x82]],
    ['a code point above Unicode', [0xf4, 0x90, 0x80, 0x80]]
  ])('refuses raw bytes containing %s instead of replacing them', async (_label, bytes) => {
    const { reader, script } = setup()
    script.push(new Response(Uint8Array.from(bytes)))

    await expect(reader.getRepositoryFile(REF, 'a.txt')).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it.each(['', '﻿hello\r\n', 'é\r\n漢字 😀\n', '�\n'])(
    'preserves every UTF-8 byte of %j',
    async (content) => {
      const { reader, script } = setup()
      const bytes = Buffer.from(content, 'utf8')
      script.push(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) {
                controller.enqueue(Uint8Array.of(byte))
              }
              controller.close()
            }
          })
        )
      )

      const result = await reader.getRepositoryFile(REF, 'a.txt')

      expect(result).toEqual({ ok: true, complete: true, data: content })
      if (!result.ok) {
        throw new Error('expected exact text')
      }
      expect(Buffer.from(result.data, 'utf8')).toEqual(bytes)
    }
  )

  it('retains the raw response byte limit and cancels an oversized stream', async () => {
    const { reader, script } = setup()
    let cancelled = false
    script.push(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          }
        }),
        { headers: { 'content-length': '1' } }
      )
    )

    await expect(reader.getRepositoryFile(REF, 'a.txt')).resolves.toEqual({
      ok: false,
      code: 'too-large'
    })
    expect(cancelled).toBe(true)
  })

  it('keeps a failed raw body read retryable instead of calling it invalid UTF-8', async () => {
    const { reader, script } = setup()
    script.push(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('connection reset'))
          }
        })
      )
    )

    await expect(reader.getRepositoryFile(REF, 'a.txt')).resolves.toEqual({
      ok: false,
      code: 'network'
    })
  })

  it('discards exact raw content when config changes during the body read', async () => {
    const { reader, script, bumpRevision } = setup()
    script.push(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bumpRevision()
              controller.enqueue(Buffer.from('hello\n'))
              controller.close()
            }
          },
          { highWaterMark: 0 }
        )
      )
    )

    await expect(reader.getRepositoryFile(REF, 'a.txt')).resolves.toEqual({
      ok: false,
      code: 'stale-config'
    })
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
