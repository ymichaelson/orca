import { describe, expect, it } from 'vitest'
import { createGitlabProjectHookClient } from './gitlab-project-hooks'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'

const bindingId = 'dc205af6-06be-43c5-8cdf-4daa4908e849'
const callbackUrl = `http://192.0.2.1:7421/webhooks/gitlab/${bindingId}`
const secret = 'synthetic-webhook-secret'
const scope = { host: 'gitlab.test:8929', projectId: '3', repoPath: '/test-project' }

type Hook = {
  id: number
  project_id: number
  url: string
  name: string
  description: string
  [key: string]: unknown
}

function server() {
  const hooks: Hook[] = []
  const writes: string[] = []
  let loseCreateResponse = false
  let forbidden = false
  let failList = false
  let rejectedEvent: string | undefined
  let httpStatus: { method: string; code: number } | undefined
  const exec = async (args: string[], options?: GlabExecOptions) => {
    expect(args.join(' ')).not.toContain(secret)
    expect(args).toContain('--hostname')
    expect(args).toContain('gitlab.test:8929')
    expect(options?.cwd).toBe('/test-project')
    const method = args[args.indexOf('--method') + 1]
    const path = args.find((arg) => arg.startsWith('projects/')) ?? ''
    expect(options?.idempotent).toBe(false)
    if (forbidden) {
      throw Object.assign(new Error('secret should never reach the UI'), {
        stderr: 'HTTP 403 Forbidden'
      })
    }
    if (method === 'GET') {
      if (failList) {
        throw Object.assign(new Error('network failed'), { stderr: 'network failed' })
      }
      const page = Number(new URL(`http://test/${path}`).searchParams.get('page') ?? 1)
      const rows = hooks.slice((page - 1) * 100, page * 100)
      return {
        stdout: `HTTP/1.1 200 OK\nContent-Type: application/json\n\n${JSON.stringify(rows)}`,
        stderr: ''
      }
    }
    writes.push(method)
    if (httpStatus && httpStatus.method === method) {
      return {
        stdout: `HTTP/1.1 ${httpStatus.code} \nContent-Type: application/json\n\n${JSON.stringify({ message: `${httpStatus.code} simulated` })}`,
        stderr: ''
      }
    }
    const body: unknown = JSON.parse(options?.stdin ?? '{}')
    if (method === 'DELETE') {
      const id = Number(path.split('/').at(-1))
      const at = hooks.findIndex((hook) => hook.id === id)
      if (at !== -1) {
        hooks.splice(at, 1)
      }
      return { stdout: '', stderr: '' }
    }
    if (!body || typeof body !== 'object' || !('url' in body) || !('token' in body)) {
      throw new Error('missing stdin JSON payload')
    }
    expect(body.token).toBe(secret)
    if (method === 'POST') {
      const hook = { id: hooks.length + 10, project_id: 3, ...body }
      const parsed: Hook = JSON.parse(JSON.stringify(hook))
      if (rejectedEvent) {
        parsed[rejectedEvent] = false
      }
      hooks.push(parsed)
      if (loseCreateResponse) {
        loseCreateResponse = false
        throw Object.assign(new Error('response lost'), { stderr: 'connection reset by peer' })
      }
      return { stdout: JSON.stringify(parsed), stderr: '' }
    }
    const existing = hooks.find((hook) => hook.id === Number(path.split('/').at(-1)))
    if (!existing) {
      throw Object.assign(new Error('gone'), { stderr: 'HTTP 404 Not Found' })
    }
    Object.assign(existing, body)
    if (rejectedEvent) {
      existing[rejectedEvent] = false
    }
    return { stdout: JSON.stringify(existing), stderr: '' }
  }
  return {
    hooks,
    writes,
    exec,
    loseNextCreateResponse: () => {
      loseCreateResponse = true
    },
    forbid: () => {
      forbidden = true
    },
    failReads: () => {
      failList = true
    },
    rejectEvent: (name: string) => {
      rejectedEvent = name
    },
    failWith: (method: string, code: number) => {
      httpStatus = { method, code }
    }
  }
}

function setup() {
  const remote = server()
  const client = createGitlabProjectHookClient({ ...scope, exec: remote.exec })
  const request = { bindingId, callbackUrl, secret }
  return { remote, client, request }
}

describe('managed GitLab project webhook', () => {
  it('creates one hook with all documented project event flags and a private stdin secret', async () => {
    const { client, remote, request } = setup()
    const result = await client.ensure(request)
    expect(result).toMatchObject({ ok: true, hookId: 10, callbackUrl })
    expect(remote.hooks).toHaveLength(1)
    expect(remote.hooks[0]).toMatchObject({
      push_events: true,
      merge_requests_events: true,
      note_events: true,
      issues_events: true,
      pipeline_events: true,
      job_events: true,
      confidential_issues_events: true,
      confidential_note_events: true,
      emoji_events: true,
      tag_push_events: true,
      wiki_page_events: true,
      deployment_events: true,
      releases_events: true,
      milestone_events: true,
      feature_flag_events: true,
      resource_access_token_events: true,
      resource_deploy_token_events: true,
      enable_ssl_verification: true
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('reconciles a lost create response instead of creating a second hook', async () => {
    const { client, remote, request } = setup()
    remote.loseNextCreateResponse()
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'unknown-outcome' })
    await expect(client.ensure(request)).resolves.toMatchObject({ ok: true, hookId: 10 })
    expect(remote.hooks).toHaveLength(1)
    expect(remote.writes.filter((method) => method === 'POST')).toHaveLength(1)
  })

  it('serializes simultaneous registrations so they cannot both create a hook', async () => {
    const { client, remote, request } = setup()
    const results = await Promise.all([client.ensure(request), client.ensure(request)])
    expect(results).toMatchObject([
      { ok: true, hookId: 10 },
      { ok: true, hookId: 10 }
    ])
    expect(remote.hooks).toHaveLength(1)
    expect(remote.writes.filter((method) => method === 'POST')).toHaveLength(1)
  })

  it('serializes registrations from separate clients for the same project', async () => {
    const { client, remote, request } = setup()
    const other = createGitlabProjectHookClient({ ...scope, exec: remote.exec })

    const results = await Promise.all([client.ensure(request), other.ensure(request)])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(remote.hooks).toHaveLength(1)
    expect(remote.writes).toEqual(['POST', 'PUT'])
  })

  it('updates the same owned hook when the external callback address or secret changes', async () => {
    const { client, remote, request } = setup()
    await client.ensure(request)
    const changed = callbackUrl.replace('192.0.2.1', '192.0.2.2')
    await expect(
      client.ensure({ ...request, callbackUrl: changed, hookId: 10 })
    ).resolves.toMatchObject({ ok: true, hookId: 10, callbackUrl: changed })
    expect(remote.hooks).toHaveLength(1)
    expect(remote.hooks[0]?.url).toBe(changed)
  })

  it('does not take over or delete an unrelated hook with the same URL', async () => {
    const { client, remote, request } = setup()
    remote.hooks.push({
      id: 20,
      project_id: 3,
      url: callbackUrl,
      name: 'Other integration',
      description: 'user-owned'
    })
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'ownership-conflict' })
    await expect(client.remove({ bindingId, hookId: 20 })).resolves.toEqual({
      ok: false,
      code: 'ownership-conflict'
    })
    expect(remote.writes).toEqual([])
  })

  it('refuses ambiguous duplicate managed hooks rather than deleting one arbitrarily', async () => {
    const { client, remote, request } = setup()
    await client.ensure(request)
    remote.hooks.push({ ...remote.hooks[0]!, id: 11 })
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'ownership-conflict' })
    expect(remote.writes).toEqual(['POST'])
  })

  it('does not create when listing hooks fails', async () => {
    const { client, remote, request } = setup()
    remote.failReads()
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'network' })
    expect(remote.writes).toEqual([])
  })

  it('paginates before deciding whether it needs to create a hook', async () => {
    const { client, remote, request } = setup()
    await client.ensure(request)
    const own = remote.hooks.pop()!
    for (let id = 100; id < 200; id++) {
      remote.hooks.push({
        id,
        project_id: 3,
        url: `https://other.test/${id}`,
        name: 'Other',
        description: ''
      })
    }
    remote.hooks.push(own)
    await expect(client.ensure(request)).resolves.toMatchObject({ ok: true, hookId: 10 })
    expect(remote.writes.filter((method) => method === 'POST')).toHaveLength(1)
  })

  it('removes only the matching managed hook and treats repeat removal as success', async () => {
    const { client, remote, request } = setup()
    await client.ensure(request)
    await expect(client.remove({ bindingId, hookId: 10 })).resolves.toEqual({ ok: true })
    await expect(client.remove({ bindingId, hookId: 10 })).resolves.toEqual({ ok: true })
    expect(remote.hooks).toEqual([])
    expect(remote.writes).toEqual(['POST', 'DELETE'])
  })

  it('returns a value-free permission error', async () => {
    const { client, remote, request } = setup()
    remote.forbid()
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'forbidden' })
  })

  it('does not mutate after caller cancellation', async () => {
    const { client, remote, request } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(client.ensure(request, controller.signal)).resolves.toEqual({
      ok: false,
      code: 'aborted'
    })
    expect(remote.writes).toEqual([])
  })

  it.each(['http://0.0.0.0:7421', 'http://user:pass@host.test', 'http://host.test?x=1'])(
    'refuses unusable external callback URL %s',
    async (callbackUrl) => {
      const { client, remote, request } = setup()
      await expect(client.ensure({ ...request, callbackUrl })).resolves.toEqual({
        ok: false,
        code: 'invalid-config'
      })
      expect(remote.writes).toEqual([])
    }
  )

  it('reports the created hook id when the instance rejects an event flag', async () => {
    const { client, remote, request } = setup()
    remote.rejectEvent('emoji_events')
    await expect(client.ensure(request)).resolves.toEqual({
      ok: false,
      code: 'event-configuration-rejected',
      hookId: 10,
      callbackUrl,
      rejectedEvents: ['emoji_events'],
      enabledEvents: expect.arrayContaining(['push_events', 'merge_requests_events']),
      unsupportedEvents: []
    })
    expect(remote.hooks).toHaveLength(1)
  })

  it('removes the owned hook when the cached hook id is stale', async () => {
    const { client, remote, request } = setup()
    await client.ensure(request)
    await expect(client.remove({ bindingId, hookId: 999 })).resolves.toEqual({ ok: true })
    expect(remote.hooks).toEqual([])
    expect(remote.writes).toEqual(['POST', 'DELETE'])
  })

  it('classifies a rate limit from the write response status line', async () => {
    const { client, remote, request } = setup()
    remote.failWith('POST', 429)
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'rate-limited' })
    expect(remote.writes).toEqual(['POST'])
    expect(remote.hooks).toEqual([])
  })

  it('classifies a forbidden write from the HTTP status line', async () => {
    const { client, remote, request } = setup()
    remote.failWith('POST', 403)
    await expect(client.ensure(request)).resolves.toEqual({ ok: false, code: 'forbidden' })
  })
})
