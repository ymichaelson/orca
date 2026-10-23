import { describe, expect, it } from 'vitest'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import { createFakeGitlab } from './forge-inbox-gitlab-fake-server'
import { createGitlabCommentPublisher } from './forge-inbox-gitlab-comment-publish'
import { INSTANCE_ID } from './forge-inbox-webhook-test-harness'

const WRITE_TOKEN = 'glpat-SECRET-write'
const READ_TOKEN = 'glpat-SECRET-read'
const BASE = 'https://git.example.com'
const MARKER = '<!-- orca-forge-comment:1:abcdef0123456789 -->'
const SIGNAL = new AbortController().signal

function target(overrides: Partial<ForgeCommentTarget> = {}): ForgeCommentTarget {
  return { instanceId: INSTANCE_ID, projectId: '42', kind: 'merge_request', iid: 7, ...overrides }
}

function setup(
  options: { failReads?: boolean; baseUrl?: string | null; writeToken?: string | null } = {}
) {
  const fake = createFakeGitlab()
  const seen: { url: string; init: RequestInit }[] = []
  const publisher = createGitlabCommentPublisher({
    http: {
      fetch: async (url: string, init: RequestInit = {}) => {
        seen.push({ url, init })
        if (options.failReads === true && (init.method ?? 'GET') === 'GET') {
          throw new Error('socket hang up')
        }
        return fake.fetch(url, init)
      }
    },
    readWriteToken: () => (options.writeToken === undefined ? WRITE_TOKEN : options.writeToken),
    readReadToken: () => READ_TOKEN,
    readConfigRevision: () => 4,
    expectedConfigRevision: 4,
    resolveInstanceBaseUrl: () => (options.baseUrl === undefined ? BASE : options.baseUrl)
  })
  return { fake, seen, publisher }
}

describe('gitlab comment publisher', () => {
  it('creates the note with the write credential and returns its id', async () => {
    const { fake, publisher } = setup()

    await expect(
      publisher.post({ target: target(), body: `Looks good.\n\n${MARKER}` }, SIGNAL)
    ).resolves.toEqual({ ok: true, noteId: 701 })
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]?.path).toBe('/merge_requests/7/notes')
    expect(fake.writes[0]?.headers['private-token']).toBe(WRITE_TOKEN)
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      body: `Looks good.\n\n${MARKER}`
    })
  })

  it('creates issue notes on the issue endpoint', async () => {
    const { fake, publisher } = setup()

    await expect(
      publisher.post({ target: target({ kind: 'issue', iid: 3 }), body: 'Note.' }, SIGNAL)
    ).resolves.toMatchObject({ ok: true })
    expect(fake.writes[0]?.path).toBe('/issues/3/notes')
  })

  it('treats a rejection as definitely not written', async () => {
    const { fake, publisher } = setup()
    fake.state.override = () => new Response('{"message":"forbidden"}', { status: 403 })

    await expect(publisher.post({ target: target(), body: 'Note.' }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'forbidden',
      mayHaveLanded: false
    })
  })

  it('treats a server error as possibly written', async () => {
    const { fake, publisher } = setup()
    fake.state.override = () => new Response('{"message":"boom"}', { status: 500 })

    await expect(publisher.post({ target: target(), body: 'Note.' }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'bad-response',
      mayHaveLanded: true
    })
  })

  it('treats a transport failure as possibly written', async () => {
    const fake = createFakeGitlab()
    const publisher = createGitlabCommentPublisher({
      http: {
        fetch: async () => {
          throw new Error('socket hang up')
        }
      },
      readWriteToken: () => WRITE_TOKEN,
      readReadToken: () => READ_TOKEN,
      readConfigRevision: () => 4,
      expectedConfigRevision: 4,
      resolveInstanceBaseUrl: () => BASE
    })

    await expect(publisher.post({ target: target(), body: 'Note.' }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'network',
      mayHaveLanded: true
    })
    expect(fake.writes).toHaveLength(0)
  })

  it('finds its own note by marker with the read credential and reports completeness', async () => {
    const { fake, seen, publisher } = setup()
    await publisher.post({ target: target(), body: `Mine.\n\n${MARKER}` }, SIGNAL)
    fake.state.notes.push({ id: 900, body: 'Someone else.', author: 'bob' })

    await expect(
      publisher.findNotes({ target: target(), marker: MARKER }, SIGNAL)
    ).resolves.toEqual({ ok: true, noteIds: [701], complete: true })
    const read = seen.find((request) => (request.init.method ?? 'GET') === 'GET')
    expect(new Headers(read?.init.headers).get('private-token')).toBe(READ_TOKEN)
  })

  it('finds notes on issues too', async () => {
    const { publisher } = setup()
    await publisher.post(
      { target: target({ kind: 'issue', iid: 3 }), body: `Issue.\n\n${MARKER}` },
      SIGNAL
    )

    await expect(
      publisher.findNotes({ target: target({ kind: 'issue', iid: 3 }), marker: MARKER }, SIGNAL)
    ).resolves.toMatchObject({ ok: true, noteIds: [701] })
  })

  it('reports an unreadable note list instead of an empty one', async () => {
    const { publisher } = setup({ failReads: true })

    await expect(
      publisher.findNotes({ target: target(), marker: MARKER }, SIGNAL)
    ).resolves.toEqual({ ok: false, code: 'network' })
  })

  it('refuses an unknown instance without any credential', async () => {
    const { publisher } = setup({ baseUrl: null, writeToken: null })

    await expect(publisher.post({ target: target(), body: 'Note.' }, SIGNAL)).resolves.toEqual({
      ok: false,
      code: 'no-credential',
      mayHaveLanded: false
    })
    await expect(
      publisher.findNotes({ target: target(), marker: MARKER }, SIGNAL)
    ).resolves.toEqual({ ok: false, code: 'no-credential' })
  })

  it('never sends to a path built from a non-positive iid', async () => {
    const { fake, publisher } = setup()

    await expect(
      publisher.post({ target: target({ iid: 0 }), body: 'Note.' }, SIGNAL)
    ).resolves.toEqual({ ok: false, code: 'bad-response', mayHaveLanded: false })
    expect(fake.writes).toHaveLength(0)
  })
})
