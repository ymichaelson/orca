import { describe, expect, it } from 'vitest'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import { createGitlabBindingCommentPorts } from './forge-inbox-gitlab-binding-comment'

const SCOPE = { host: 'gitlab.test', projectId: '9', repoPath: '/test-project' }
const SIGNAL = new AbortController().signal
const MARKER = '<!-- orca-forge-comment:1:abcdef0123456789 -->'
const BODY = `Looks good to me.\n\n${MARKER}`
const SHA = 'a'.repeat(40)

type ExecResult = { stdout: string; stderr: string }
type ExecCall = { args: string[]; options?: GlabExecOptions }

function response(status: number, body: unknown): ExecResult {
  return {
    stdout: `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
    stderr: ''
  }
}

function fakeExec(handler: (call: ExecCall) => ExecResult) {
  const calls: ExecCall[] = []
  const exec = async (args: string[], options?: GlabExecOptions): Promise<ExecResult> => {
    const call = { args, options }
    calls.push(call)
    return handler(call)
  }
  return { calls, exec }
}

function target(overrides: Partial<ForgeCommentTarget> = {}): ForgeCommentTarget {
  return {
    instanceId: 'caller-instance',
    projectId: '999',
    kind: 'merge_request',
    iid: 7,
    ...overrides
  }
}

function setup(handler: (call: ExecCall) => ExecResult) {
  const fake = fakeExec(handler)
  const ports = createGitlabBindingCommentPorts({ ...SCOPE, exec: fake.exec })
  return { fake, ports }
}

function pathOf(call: ExecCall): string {
  return call.args.find((arg) => arg.startsWith('projects/')) ?? ''
}

function assertNoSecretOnArgv(call: ExecCall): void {
  const argv = call.args.join(' ')
  expect(argv).not.toContain('glpat-')
  expect(call.args.some((arg) => /\/\/[^/\s]*@/.test(arg))).toBe(false)
  expect(argv).not.toContain(BODY)
}

describe('glab binding comment ports', () => {
  it('posts a merge request note to the bound project with the body on stdin', async () => {
    const { fake, ports } = setup(() => response(201, { id: 701 }))

    await expect(ports.post({ target: target(), body: BODY }, SIGNAL)).resolves.toEqual({
      ok: true,
      noteId: 701
    })

    const [call] = fake.calls
    expect(call?.args).toEqual([
      'api',
      '-i',
      '--hostname',
      'gitlab.test',
      '--method',
      'POST',
      'projects/9/merge_requests/7/notes',
      '--input',
      '-'
    ])
    expect(call?.options).toMatchObject({
      cwd: '/test-project',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      idempotent: false
    })
    expect(call?.options?.stdin).toBe(JSON.stringify({ body: BODY }))
    assertNoSecretOnArgv(call!)
  })

  it('posts an issue note to the issue notes endpoint', async () => {
    const { fake, ports } = setup(() => response(201, { id: 55 }))

    await expect(
      ports.post({ target: target({ kind: 'issue', iid: 3 }), body: BODY }, SIGNAL)
    ).resolves.toEqual({ ok: true, noteId: 55 })
    expect(pathOf(fake.calls[0]!)).toBe('projects/9/issues/3/notes')
  })

  it('treats a transport failure after send as possibly landed', async () => {
    const { fake, ports } = setup(() => {
      throw Object.assign(new Error('connection reset'), { stderr: 'connection reset by peer' })
    })

    await expect(ports.post({ target: target(), body: BODY }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'network',
      mayHaveLanded: true
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('treats an HTTP 401 rejection as definitely not written', async () => {
    const { ports } = setup(() => {
      throw Object.assign(new Error('unauthorized'), { stderr: 'HTTP 401 Unauthorized' })
    })

    await expect(ports.post({ target: target(), body: BODY }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'unauthorized',
      mayHaveLanded: false
    })
  })

  it('reads the head from diff_refs and falls back to sha', async () => {
    const preferred = setup(() =>
      response(200, { sha: 'b'.repeat(40), diff_refs: { head_sha: SHA } })
    )
    await expect(preferred.ports.readHead(target(), SIGNAL)).resolves.toEqual({
      ok: true,
      sha: SHA
    })
    expect(pathOf(preferred.fake.calls[0]!)).toBe('projects/9/merge_requests/7')

    const fallback = setup(() => response(200, { sha: SHA, diff_refs: null }))
    await expect(fallback.ports.readHead(target(), SIGNAL)).resolves.toEqual({ ok: true, sha: SHA })
  })

  it('rejects a head that is not a 40-hex sha', async () => {
    const { ports } = setup(() => response(200, { sha: 'c'.repeat(64), diff_refs: null }))
    await expect(ports.readHead(target(), SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
  })

  it('does not read a head for an issue or an invalid target', async () => {
    const { fake, ports } = setup(() => response(200, { sha: SHA }))
    await expect(ports.readHead(target({ kind: 'issue', iid: 3 }), SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    await expect(ports.readHead(target({ iid: 0 }), SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response'
    })
    expect(fake.calls).toEqual([])
  })

  it('finds notes by marker across two pages and reports completeness', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: 100 + index,
      body: index === 4 ? BODY : 'Someone else.'
    }))
    const page2 = [
      { id: 900, body: `Also mine.\n\n${MARKER}` },
      { id: 901, body: 'Last note.' }
    ]
    const { fake, ports } = setup((call) =>
      pathOf(call).includes('page=2') ? response(200, page2) : response(200, page1)
    )

    await expect(ports.findNotes({ target: target(), marker: MARKER }, SIGNAL)).resolves.toEqual({
      ok: true,
      noteIds: [104, 900],
      complete: true
    })
    expect(fake.calls.map(pathOf)).toEqual([
      'projects/9/merge_requests/7/notes?per_page=100&page=1&sort=desc&order_by=created_at',
      'projects/9/merge_requests/7/notes?per_page=100&page=2&sort=desc&order_by=created_at'
    ])
  })

  it('reports an incomplete listing when the second page is full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: 'Someone else.'
    }))
    const { fake, ports } = setup(() => response(200, fullPage))

    await expect(ports.findNotes({ target: target(), marker: MARKER }, SIGNAL)).resolves.toEqual({
      ok: true,
      noteIds: [],
      complete: false
    })
    expect(fake.calls).toHaveLength(2)
  })

  it('finds issue notes on the issue endpoint', async () => {
    const { fake, ports } = setup(() => response(200, [{ id: 12, body: BODY }]))

    await expect(
      ports.findNotes({ target: target({ kind: 'issue', iid: 3 }), marker: MARKER }, SIGNAL)
    ).resolves.toEqual({ ok: true, noteIds: [12], complete: true })
    expect(pathOf(fake.calls[0]!)).toBe(
      'projects/9/issues/3/notes?per_page=100&page=1&sort=desc&order_by=created_at'
    )
  })

  it('refuses an invalid target instead of falling back to the binding', async () => {
    const { fake, ports } = setup(() => response(201, { id: 1 }))

    await expect(ports.post({ target: target({ iid: 0 }), body: BODY }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response',
      mayHaveLanded: false
    })
    await expect(
      ports.findNotes({ target: target({ iid: -1 }), marker: MARKER }, SIGNAL)
    ).resolves.toEqual({ ok: false, code: 'bad-response' })
    expect(fake.calls).toEqual([])
  })

  it('refuses an invalid target kind at runtime', async () => {
    const { fake, ports } = setup(() => response(201, { id: 1 }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercising the runtime guard for a kind the type already forbids.
    const invalid = { ...target(), kind: 'discussion' as never }

    await expect(ports.post({ target: invalid, body: BODY }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response',
      mayHaveLanded: false
    })
    expect(fake.calls).toEqual([])
  })
})
