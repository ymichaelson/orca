import { describe, expect, it } from 'vitest'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'

const TOKEN = 'glpat-SECRET-read-token'
const BASE_URL = 'https://git.example.com/gitlab'

type Request = { url: string; init: RequestInit }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function setup(options: { revision?: () => number; onFetch?: () => void } = {}) {
  const requests: Request[] = []
  const script: Response[] = []
  const reader = createGitlabApiReader(
    {
      http: {
        fetch: async (url: string, init: RequestInit = {}) => {
          requests.push({ url, init })
          options.onFetch?.()
          const next = script.shift()
          if (next === undefined) {
            throw new Error('unscripted fetch')
          }
          return next
        }
      },
      readToken: () => TOKEN,
      readConfigRevision: options.revision ?? (() => 1)
    },
    { baseUrl: BASE_URL, projectId: '42', expectedConfigRevision: 1 }
  )
  return { reader, requests, script }
}

describe('gitlab current user read', () => {
  it('reads the instance-level identity and keeps only bounded fields', async () => {
    const { reader, requests, script } = setup()
    script.push(
      json({
        id: 17,
        name: 'Ada Lovelace',
        username: 'ada',
        email: 'ada@example.com',
        commit_email: 'ada@users.noreply.git.example.com',
        avatar_url: 'https://git.example.com/uploads/ada.png',
        web_url: 'https://git.example.com/ada',
        private_profile: true,
        state: 'active'
      })
    )

    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: true,
      complete: true,
      data: {
        name: 'Ada Lovelace',
        username: 'ada',
        email: 'ada@example.com',
        commit_email: 'ada@users.noreply.git.example.com'
      }
    })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/gitlab/api/v4/user')
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

  it('treats absent and null email fields as null', async () => {
    const { reader, script } = setup()
    script.push(json({ name: 'Ada Lovelace', username: 'ada' }))
    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: true,
      complete: true,
      data: { name: 'Ada Lovelace', username: 'ada', email: null, commit_email: null }
    })

    script.push(json({ name: 'Ada Lovelace', username: 'ada', email: null, commit_email: null }))
    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: true,
      complete: true,
      data: { name: 'Ada Lovelace', username: 'ada', email: null, commit_email: null }
    })
  })

  it.each([
    ['a missing name', { username: 'ada' }],
    ['a non-string name', { name: 7, username: 'ada' }],
    ['an empty name', { name: '', username: 'ada' }],
    ['a missing username', { name: 'Ada Lovelace' }],
    ['an empty username', { name: 'Ada Lovelace', username: '' }],
    ['a non-string email', { name: 'Ada Lovelace', username: 'ada', email: 7 }],
    ['an empty commit email', { name: 'Ada Lovelace', username: 'ada', commit_email: '' }],
    ['an oversized name', { name: 'a'.repeat(256), username: 'ada', email: 'ada@example.com' }],
    [
      'an oversized email',
      { name: 'Ada Lovelace', username: 'ada', email: `${'a'.repeat(320)}@example.com` }
    ]
  ])('refuses a response with %s', async (_case, body) => {
    const { reader, script } = setup()
    script.push(json(body))

    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('propagates authentication and instance failures', async () => {
    const { reader, script } = setup()
    script.push(json({ message: 'denied' }, { status: 401 }))
    script.push(json({ message: 'forbidden' }, { status: 403 }))
    script.push(json({ message: 'missing' }, { status: 404 }))

    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'unauthorized'
    })
    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'forbidden'
    })
    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
  })

  it('refuses to send when config is already stale', async () => {
    const { reader, requests, script } = setup({ revision: () => 2 })
    script.push(json({ name: 'Ada Lovelace', username: 'ada' }))

    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'stale-config'
    })
    expect(requests).toEqual([])
  })

  it('discards the identity when config changed while the response was in flight', async () => {
    let revision = 1
    const { reader, requests, script } = setup({
      revision: () => revision,
      onFetch: () => {
        revision = 2
      }
    })
    script.push(json({ name: 'Ada Lovelace', username: 'ada' }))

    await expect(reader.getCurrentUser()).resolves.toEqual({
      ok: false,
      code: 'stale-config'
    })
    expect(requests).toHaveLength(1)
  })
})
