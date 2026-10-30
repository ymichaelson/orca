import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { GITLAB_API_RESPONSE_MAX_BYTES } from './forge-inbox-gitlab-api-request'
import {
  createGlabApiRequester,
  createGlabApiTextRequester,
  type GlabApiExec
} from './forge-inbox-glab-api-requester'

const HOST = 'gitlab.test'
const REPO_PATH = '/repo'

type Call = { args: string[]; options?: GlabExecOptions }

function responding(stdout: string): { exec: GlabApiExec; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    exec: async (args, options) => {
      calls.push({ args, options })
      return { stdout, stderr: '' }
    }
  }
}

function rejecting(error: Error): GlabApiExec {
  return async () => {
    throw error
  }
}

function execError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('glab failed'), { stderr, ...extra })
}

function response(body: string, headers: Record<string, string> = {}): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return ['HTTP/2 200', ...lines, '', body].join('\r\n')
}

describe('glab api requester', () => {
  it('runs glab api -i against the configured host with the full route and query', async () => {
    const { exec, calls } = responding(response('{"iid":7}', { 'x-next-page': '2' }))
    const requester = createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec,
      signal: undefined
    })

    const result = await requester.get('projects/3/merge_requests/7', {
      per_page: '100',
      page: '2'
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'api',
      '-i',
      '--hostname',
      HOST,
      'projects/3/merge_requests/7?per_page=100&page=2'
    ])
    expect(calls[0].options).toMatchObject({ cwd: REPO_PATH })
    expect(result.ok && result.json).toEqual({ iid: 7 })
    expect(result.ok && result.headers.get('x-next-page')).toBe('2')
  })

  it('drops a leading slash so the route stays a valid glab path', async () => {
    const { exec, calls } = responding(response('{"iid":7}'))

    await createGlabApiRequester({ hostname: HOST, repoPath: REPO_PATH, exec }).get(
      '/projects/3/merge_requests/7'
    )

    expect(calls[0].args.at(-1)).toBe('projects/3/merge_requests/7')
  })

  it.each([
    'https://evil.example/api/v4/projects/3/merge_requests/7',
    'http://evil.example/projects/3',
    '//evil.example/projects/3'
  ])('refuses the absolute route %j without running glab', async (route) => {
    const { exec, calls } = responding(response('{}'))

    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec
    }).get(route)

    expect(result).toEqual({ ok: false, code: 'bad-response' })
    expect(calls).toEqual([])
  })

  it('passes the abort signal through to glab', async () => {
    const controller = new AbortController()
    const { exec, calls } = responding(response('{}'))

    await createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec,
      signal: controller.signal
    }).get('projects/3/issues/1')

    expect(calls[0].options?.signal).toBe(controller.signal)
  })

  it('rejects a body over the response cap without parsing it', async () => {
    const body = `"${'x'.repeat(GITLAB_API_RESPONSE_MAX_BYTES)}"`
    const { exec } = responding(response(body))

    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec
    }).get('projects/3/issues/1')

    expect(result).toEqual({ ok: false, code: 'bad-response' })
  })

  it('rejects a non-JSON body', async () => {
    const { exec } = responding(response('<html>not json</html>'))

    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec
    }).get('projects/3/issues/1')

    expect(result).toEqual({ ok: false, code: 'bad-response' })
  })

  it.each([
    ['glab: 404 Not Found (HTTP 404)', 'not-found'],
    ['glab: 401 Unauthorized (HTTP 401)', 'unauthorized'],
    ['glab: 403 Forbidden (HTTP 403)', 'forbidden'],
    ['glab: 429 Too Many Requests (HTTP 429)', 'rate-limited'],
    ['glab: 500 Internal Server Error (HTTP 500)', 'network'],
    ['glab: something opaque went wrong', 'network']
  ])('maps a failed exit reporting %j to %s', async (stderr, code) => {
    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec: rejecting(execError(stderr))
    }).get('projects/3/issues/1')

    expect(result).toEqual({ ok: false, code })
  })

  it('treats a missing glab binary as a transport failure, never a credential failure', async () => {
    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: tmpdir(),
      exec: rejecting(
        Object.assign(new Error('spawn glab ENOENT'), {
          code: 'ENOENT',
          syscall: 'spawn glab',
          stderr: ''
        })
      )
    }).get('projects/3/issues/1')

    expect(result).toEqual({ ok: false, code: 'network' })
  })

  it('reports a missing checkout rather than a missing glab binary', async () => {
    const missingCheckout = join(tmpdir(), `orca-missing-checkout-${randomUUID()}`)

    const result = await createGlabApiRequester({
      hostname: HOST,
      repoPath: missingCheckout,
      exec: rejecting(
        Object.assign(new Error('spawn glab ENOENT'), {
          code: 'ENOENT',
          syscall: 'spawn glab',
          path: 'glab',
          stderr: ''
        })
      )
    }).get('projects/3/issues/1')

    expect(result).toEqual({ ok: false, code: 'missing-checkout' })
  })

  it('turns an invalid text-response header into a typed failure', async () => {
    const malformed = ['HTTP/1.1 200 OK', 'x-test: a\u0000b', '', 'raw file body'].join('\r\n')
    const { exec } = responding(malformed)

    const result = await createGlabApiTextRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec
    }).getText('projects/3/repository/files/a%2Eb/raw', { ref: 'main' })

    expect(result).toEqual({ ok: false, code: 'bad-response' })
  })

  it('returns raw text for the text requester without JSON parsing', async () => {
    const { exec } = responding(response('raw file body'))

    const result = await createGlabApiTextRequester({
      hostname: HOST,
      repoPath: REPO_PATH,
      exec
    }).getText('projects/3/repository/files/a%2Eb/raw', { ref: 'main' })

    expect(result.ok && result.text).toBe('raw file body')
    expect(result.ok && result.headers.get('x-next-page')).toBeNull()
  })
})
