import { describe, expect, it } from 'vitest'
import { createGitlabPatchHeadReader } from './forge-inbox-gitlab-patch-head'

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

function branch(name: string, id: string = SHA) {
  return { name, commit: { id }, merged: false, protected: false }
}

function setup(
  options: {
    revision?: () => number
    token?: string | null
    baseUrl?: string | null
  } = {}
) {
  const requests: Request[] = []
  const script: Response[] = []
  const reader = createGitlabPatchHeadReader({
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
    readReadToken: () => (options.token === undefined ? TOKEN : options.token),
    readConfigRevision: options.revision ?? (() => 1),
    expectedConfigRevision: 1,
    resolveInstanceBaseUrl: () => (options.baseUrl === undefined ? BASE_URL : options.baseUrl)
  })
  return { reader, requests, script }
}

const request = { instanceId: 'instance-1', projectId: '42', branch: 'feature/deep/topic' }
const signal = new AbortController().signal

describe('gitlab patch head reader', () => {
  it('reads the configured project branch head with the read credential', async () => {
    const { reader, requests, script } = setup()
    script.push(json(branch('feature/deep/topic')))

    await expect(reader(request, signal)).resolves.toEqual({ ok: true, sha: SHA })
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

  it('fails closed without a configured instance', async () => {
    const { reader, requests } = setup({ baseUrl: null })

    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'no-credential'
    })
    expect(requests).toEqual([])
  })

  it('fails closed without a read credential', async () => {
    const { reader, requests } = setup({ token: null })

    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'no-credential'
    })
    expect(requests).toEqual([])
  })

  it('fails closed when config changed before the read', async () => {
    const { reader, requests, script } = setup({ revision: () => 2 })
    script.push(json(branch('feature/deep/topic')))

    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'stale-config'
    })
    expect(requests).toEqual([])
  })

  it('refuses an invalid branch name without a request', async () => {
    const { reader, requests } = setup()

    await expect(reader({ ...request, branch: 'main..topic' }, signal)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(requests).toEqual([])
  })

  it('refuses a response bound to a different branch name', async () => {
    const { reader, script } = setup()
    script.push(json(branch('other')))

    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('propagates project and authorization failures', async () => {
    const { reader, script } = setup()
    script.push(json({ message: 'gone' }, { status: 404 }))
    script.push(json({ message: 'denied' }, { status: 403 }))

    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'not-found'
    })
    await expect(reader(request, signal)).resolves.toEqual({
      ok: false,
      code: 'forbidden'
    })
  })
})
