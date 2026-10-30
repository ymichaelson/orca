import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  getProjectBinding,
  setProjectBindingProgress,
  upsertProjectBinding
} from './forge-inbox-project-binding'
import { setProjectBindingSecret } from './forge-inbox-project-binding-secret'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { ForgeWebhookIngress } from './forge-inbox-webhook-ingress'
import {
  createWebhookHarness,
  fakeSecretStore,
  PROJECT_ID,
  WEBHOOK_TOKEN,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const NOTE = JSON.stringify({ object_kind: 'note', project: { id: Number(PROJECT_ID) } })

type Reply = { status: number; text: string }
type StoredDelivery = {
  binding_id: string
  instance_id: string | null
  project_id: string
  event_kind: string
  event_uuid: string | null
  config_uuid: string | null
  state: string
  policy_generation: number | null
  body: Buffer
}

function textColumn(row: SqliteRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`forge inbox column ${column} is not text`)
  }
  return value
}

function storedDelivery(row: SqliteRow): StoredDelivery {
  const body = row.body
  if (!(body instanceof Uint8Array)) {
    throw new Error('forge inbox webhook body is not binary')
  }
  const generation = row.policy_generation
  return {
    binding_id: textColumn(row, 'binding_id'),
    instance_id: row.instance_id === null ? null : textColumn(row, 'instance_id'),
    project_id: textColumn(row, 'project_id'),
    event_kind: textColumn(row, 'event_kind'),
    event_uuid: row.event_uuid === null ? null : textColumn(row, 'event_uuid'),
    config_uuid: row.config_uuid === null ? null : textColumn(row, 'config_uuid'),
    state: textColumn(row, 'state'),
    policy_generation: typeof generation === 'number' ? generation : null,
    body: Buffer.from(body)
  }
}

function stableHeaders(id: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-gitlab-token': WEBHOOK_TOKEN,
    'x-gitlab-event': 'Note Hook',
    'webhook-id': id,
    'x-gitlab-webhook-uuid': 'cfg-1',
    'x-gitlab-event-uuid': 'evt-1',
    ...extra
  }
}

function send(
  port: number,
  path: string,
  options: {
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string
  } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? path,
        method: options.method ?? 'POST',
        headers: options.headers ?? stableHeaders('m-1'),
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end(options.body ?? NOTE)
  })
}

function closedOf(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

const rawSockets: net.Socket[] = []

function openRaw(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.removeListener('error', reject)
      socket.on('error', () => undefined)
      socket.resume()
      resolve(socket)
    })
    socket.once('error', reject)
    rawSockets.push(socket)
  })
}

function rawHead(path: string, contentLength: number, headers = stableHeaders('m-raw')): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  return `POST ${path} HTTP/1.1\r\nHost: x\r\ncontent-length: ${contentLength}\r\n${lines.join('\r\n')}\r\n\r\n`
}

function readUntilClose(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    socket.on('close', () => resolve(text))
    socket.on('error', () => undefined)
  })
}

describe('forge inbox webhook ingress', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let ingress: ForgeWebhookIngress
  let bindingId: string
  let port: number
  let path: string

  async function startIngress(options: ConstructorParameters<typeof ForgeWebhookIngress>[1] = {}) {
    ingress = new ForgeWebhookIngress(ledger, options)
    port = (await ingress.listen({ host: '127.0.0.1', port: 0 })).port
  }

  function connectBinding(): void {
    const ctx = ledger.ledgerContext()
    if (getProjectBinding(ctx, bindingId)) {
      return
    }
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: Number(PROJECT_ID),
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    const secret = setProjectBindingSecret(ctx, { bindingId, secret: WEBHOOK_TOKEN })
    if (!secret.ok) {
      throw new Error(`fixture could not store the binding secret: ${secret.reason}`)
    }
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    const policy = updateProjectEventPolicy(ctx, {
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { enabled: true }
    })
    if (!policy.ok) {
      throw new Error(`fixture could not enable the project policy: ${policy.reason}`)
    }
    setProjectBindingProgress(ctx, bindingId, { state: 'connected', hookId: 7 })
  }

  const rows = (): StoredDelivery[] =>
    ledger
      .ledgerContext()
      .db.prepare(
        `SELECT binding_id, instance_id, project_id, event_kind, event_uuid, config_uuid, state,
                policy_generation, body
         FROM webhook_deliveries`
      )
      .all()
      .map(storedDelivery)

  const post = (options: Parameters<typeof send>[2] = {}) => send(port, path, options)

  beforeEach(async () => {
    harness = createWebhookHarness()
    ledger = harness.open()
    bindingId = randomUUID()
    path = `/webhooks/gitlab/${bindingId}`
    connectBinding()
    await startIngress()
  })

  afterEach(async () => {
    for (const socket of rawSockets.splice(0)) {
      socket.destroy()
    }
    await ingress.stop()
    harness.dispose()
  })

  describe('admission', () => {
    it('durably admits an authenticated delivery before acknowledging, surviving restart', async () => {
      const reply = await post({ body: NOTE })
      expect(reply.status).toBe(202)
      expect(JSON.parse(reply.text)).toEqual({ code: 'queued' })
      expect(ledger.listWebhookDeliveries({ limit: 100 })).toEqual([])
      expect(rows()).toHaveLength(1)

      await ingress.stop()
      ledger.close()
      ledger = harness.open()
      const [row] = rows()
      expect(row).toMatchObject({
        binding_id: bindingId,
        instance_id: null,
        project_id: 'group/demo',
        event_kind: 'Note Hook',
        event_uuid: 'evt-1',
        config_uuid: 'cfg-1',
        state: 'pending',
        policy_generation: 1
      })
      expect(row.body.toString()).toBe(NOTE)
      expect(JSON.stringify(row)).not.toContain(WEBHOOK_TOKEN)
    })

    it('dedupes a GitLab retry across restart without storing the retry', async () => {
      await post({ body: NOTE })
      await ingress.stop()
      ledger.close()
      ledger = harness.open()
      await startIngress()

      const retry = await post({ body: NOTE.replace('note', 'note ') })
      expect(retry.status).toBe(202)
      expect(JSON.parse(retry.text)).toEqual({ code: 'duplicate' })
      const stored = rows()
      expect(stored).toHaveLength(1)
      expect(stored[0].body.toString()).toBe(NOTE)
    })

    it('does not merge deliveries that share config and event UUIDs but differ in message id', async () => {
      await post({ headers: stableHeaders('m-1'), body: NOTE })
      await post({ headers: stableHeaders('m-2'), body: NOTE.replace('note', 'note2') })
      expect(rows()).toHaveLength(2)
    })

    it('accepts Idempotency-Key as the legacy alias and prefers webhook-id', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      await post({ headers: { ...noId, 'idempotency-key': 'legacy-1' } })
      await post({ headers: { ...noId, 'idempotency-key': 'legacy-1' } })
      expect(rows()).toHaveLength(1)

      await post({ headers: stableHeaders('wh-9', { 'idempotency-key': 'legacy-1' }) })
      expect(rows()).toHaveLength(2)
    })

    it('treats webhook-id and Idempotency-Key as one identity namespace', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      await post({ headers: stableHeaders('same-7') })
      const migrated = await post({ headers: { ...noId, 'idempotency-key': 'same-7' } })
      expect(migrated.status).toBe(202)
      expect(JSON.parse(migrated.text)).toEqual({ code: 'duplicate' })
      expect(rows()).toHaveLength(1)
    })

    it('refuses a delivery with no stable message id', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      const refused = await post({ headers: noId })
      expect(refused.status).toBe(400)
      expect(JSON.parse(refused.text)).toEqual({ code: 'missing-delivery-id' })
      expect(rows()).toHaveLength(0)
    })

    it('refuses ambiguous duplicate identity headers', async () => {
      const socket = await openRaw(port)
      const head = rawHead(path, NOTE.length, stableHeaders('m-1')).replace(
        '\r\n\r\n',
        '\r\nwebhook-id: m-2\r\n\r\n'
      )
      socket.write(head + NOTE)
      const text = await readUntilClose(socket)
      expect(text).toMatch(/^HTTP\/1\.1 400 /)
      expect(rows()).toHaveLength(0)
    })

    it('parks a delivery whose binding has no policy yet and keeps its body', async () => {
      ledger.ledgerContext().db.prepare('DELETE FROM project_event_policies').run()

      const reply = await post()

      expect(reply.status).toBe(202)
      expect(JSON.parse(reply.text)).toEqual({ code: 'parked' })
      expect(rows()).toMatchObject([
        { state: 'parked', policy_generation: null, body: Buffer.from(NOTE) }
      ])
      expect(ledger.listWebhookDeliveries({ limit: 100 })).toEqual([])
    })

    it('finishes a disabled project policy as done with an empty body and still queues', async () => {
      const disabled = updateProjectEventPolicy(ledger.ledgerContext(), {
        repoId: 'repo-1',
        expectedGeneration: 1,
        patch: { enabled: false }
      })
      expect(disabled.ok).toBe(true)

      const reply = await post()

      expect(reply.status).toBe(202)
      expect(JSON.parse(reply.text)).toEqual({ code: 'queued' })
      expect(rows()).toMatchObject([{ state: 'done', body: Buffer.alloc(0) }])
      expect(ledger.getWebhookQueueStatus().pending).toBe(0)
    })
  })

  describe('rejections never leave a row or a run', () => {
    const cases: [string, () => Promise<Reply>, number][] = [
      [
        'wrong token',
        () => post({ headers: stableHeaders('a', { 'x-gitlab-token': 'nope' }) }),
        401
      ],
      [
        'longer wrong token',
        () => post({ headers: stableHeaders('a', { 'x-gitlab-token': 'x'.repeat(5000) }) }),
        401
      ],
      [
        'missing token',
        () => {
          const { 'x-gitlab-token': _t, ...rest } = stableHeaders('a')
          return post({ headers: rest })
        },
        401
      ],
      ['non-uuid path', () => post({ path: '/webhooks/gitlab/gitlab-main' }), 404],
      ['unknown binding', () => post({ path: `/webhooks/gitlab/${randomUUID()}` }), 404],
      ['query target override', () => post({ path: `${path}?instance=other` }), 404],
      ['wrong path', () => post({ path: '/hooks' }), 404],
      ['GET', () => post({ method: 'GET', body: '' }), 405],
      [
        'text/plain',
        () => post({ headers: stableHeaders('a', { 'content-type': 'text/plain' }) }),
        415
      ],
      ['malformed JSON', () => post({ body: '{"project":' }), 400],
      ['invalid UTF-8', () => post({ body: Buffer.from([0x7b, 0xff, 0x7d]) }), 400],
      ['array body', () => post({ body: '[1]' }), 400],
      ['unconfigured project', () => post({ body: '{"project":{"id":777}}' }), 422],
      ['unsafe project id', () => post({ body: '{"project":{"id":99999999999999999999}}' }), 400],
      [
        'conflicting project ids',
        () => post({ body: `{"project_id":${PROJECT_ID},"project":{"id":43}}` }),
        400
      ],
      ['no project id', () => post({ body: '{"object_kind":"note"}' }), 400]
    ]

    it.each(cases)('%s', async (_name, run, status) => {
      const reply = await run()
      expect(reply.status).toBe(status)
      expect(reply.text).not.toContain(WEBHOOK_TOKEN)
      expect(rows()).toHaveLength(0)
      expect(ledger.getWebhookQueueStatus().pending).toBe(0)
    })

    it('rejects a UTF-8 BOM-prefixed body that would not parse from the stored bytes', async () => {
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NOTE)])
      const reply = await post({ body: bom })
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.text)).toEqual({ code: 'invalid-body' })
      expect(rows()).toHaveLength(0)
    })

    it('answers a missing token 401 without consulting storage', async () => {
      ledger.close()
      const { 'x-gitlab-token': _t, ...rest } = stableHeaders('a')
      expect((await post({ headers: rest })).status).toBe(401)
      expect((await post({ headers: stableHeaders('a', { 'x-gitlab-token': '' }) })).status).toBe(
        401
      )
    })

    it('refuses a binding that is not connected', async () => {
      setProjectBindingProgress(ledger.ledgerContext(), bindingId, { state: 'registering' })

      const reply = await post()

      expect(reply.status).toBe(409)
      expect(JSON.parse(reply.text)).toEqual({ code: 'binding-not-ready' })
      expect(rows()).toHaveLength(0)
    })

    it('names a project id that is not the binding project', async () => {
      const reply = await post({ body: '{"project":{"id":777}}' })
      expect(reply.status).toBe(422)
      expect(JSON.parse(reply.text)).toEqual({ code: 'project-not-configured' })
      expect(rows()).toHaveLength(0)
    })

    it('reports an undecryptable binding secret as unavailable and never falls back', async () => {
      await ingress.stop()
      ledger.close()
      ledger = ledgerWithOtherKey()
      await startIngress()
      const reply = await post()
      expect(reply.status).toBe(503)
      expect(reply.text).not.toContain(WEBHOOK_TOKEN)
      expect(rows()).toHaveLength(0)
    })

    function ledgerWithOtherKey(): ForgeInboxLedger {
      return harness.open({ secretStore: fakeSecretStore() })
    }
  })

  describe('bounds', () => {
    it('rejects an oversized declared body without buffering it', async () => {
      const socket = await openRaw(port)
      socket.write(rawHead(path, 2 * 1024 * 1024))
      const text = await readUntilClose(socket)
      expect(text).toMatch(/^HTTP\/1\.1 413/)
      expect(rows()).toHaveLength(0)
    })

    it('rejects an oversized chunked body', async () => {
      const socket = await openRaw(port)
      const head = rawHead(path, 0).replace(
        'content-length: 0\r\n',
        'transfer-encoding: chunked\r\n'
      )
      socket.write(head)
      const chunk = Buffer.alloc(256 * 1024, 'a')
      const reply = readUntilClose(socket)
      for (let i = 0; i < 6 && !socket.destroyed; i++) {
        socket.write(`${chunk.length.toString(16)}\r\n`)
        socket.write(chunk)
        socket.write('\r\n')
        await new Promise((r) => setImmediate(r))
      }
      expect(await reply).toMatch(/^HTTP\/1\.1 413/)
      expect(rows()).toHaveLength(0)
    })

    it('drops a slow partial request at the absolute deadline', async () => {
      await ingress.stop()
      await startIngress({ requestDeadlineMs: 120 })
      const socket = await openRaw(port)
      const closed = closedOf(socket)
      socket.on('error', () => undefined)
      socket.write(rawHead(path, 100))
      socket.write('{')
      await closed
      expect(rows()).toHaveLength(0)
    })

    it('drops a slow partial header block at the absolute deadline from connect', async () => {
      await ingress.stop()
      await startIngress({ requestDeadlineMs: 120 })
      const socket = await openRaw(port)
      const closed = closedOf(socket)
      socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nx-slow: `)
      await closed
      expect(rows()).toHaveLength(0)
    })

    it('does not extend the deadline when a client trickles bytes', async () => {
      await ingress.stop()
      await startIngress({ requestDeadlineMs: 150 })
      const socket = await openRaw(port)
      const closed = closedOf(socket)
      socket.on('error', () => undefined)
      socket.write(rawHead(path, 1000))
      const trickle = setInterval(() => socket.destroyed || socket.write('x'), 20)
      try {
        await closed
      } finally {
        clearInterval(trickle)
      }
      expect(rows()).toHaveLength(0)
    })

    it('caps concurrent requests and recovers after the stalled ones end', async () => {
      await ingress.stop()
      await startIngress({ maxConcurrentRequests: 2, requestDeadlineMs: 200 })
      const stalled = await Promise.all([openRaw(port), openRaw(port)])
      const closes = stalled.map((s) => {
        s.on('error', () => undefined)
        return closedOf(s)
      })
      for (const s of stalled) {
        s.write(rawHead(path, 100))
      }
      await vi.waitFor(() => expect(ingress.status().inFlight).toBe(2))
      const refused = await post()
      expect(refused.status).toBe(503)
      expect(rows()).toHaveLength(0)

      await Promise.all(closes)
      expect((await post()).status).toBe(202)
    })
  })

  describe('stale authentication', () => {
    async function partialThen(change: () => void): Promise<string> {
      const socket = await openRaw(port)
      const reply = readUntilClose(socket)
      socket.write(rawHead(path, NOTE.length))
      socket.write(NOTE.slice(0, 5))
      await vi.waitFor(() => expect(ingress.status().inFlight).toBe(1))
      change()
      socket.write(NOTE.slice(5))
      return reply
    }

    it('does not commit when the binding secret rotates during the body', async () => {
      const text = await partialThen(() => {
        const rotated = setProjectBindingSecret(ledger.ledgerContext(), {
          bindingId,
          secret: 'rotated-token'
        })
        expect(rotated.ok).toBe(true)
      })
      expect(text).toMatch(/^HTTP\/1\.1 401 /)
      expect(rows()).toHaveLength(0)
    })

    it('does not commit when the binding leaves connected during the body', async () => {
      const text = await partialThen(() => {
        setProjectBindingProgress(ledger.ledgerContext(), bindingId, { state: 'registering' })
      })
      expect(text).toMatch(/^HTTP\/1\.1 409 /)
      expect(rows()).toHaveLength(0)
    })
  })

  describe('storage failure', () => {
    it('answers 500 and leaves no partial row when the insert genuinely fails', async () => {
      const side = new Database(harness.dbPath)
      try {
        side.exec(
          `CREATE TRIGGER fail_insert BEFORE INSERT ON webhook_deliveries
           BEGIN SELECT RAISE(ABORT, 'disk full'); END`
        )
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const failed = await post()
        expect(warn).toHaveBeenCalledWith(
          '[forge-inbox] webhook admission failed',
          expect.any(String)
        )
        expect(JSON.stringify(warn.mock.calls)).not.toContain('disk full')
        warn.mockRestore()
        expect(failed.status).toBe(500)
        expect(JSON.parse(failed.text)).toEqual({ code: 'storage-failed' })
        expect(rows()).toHaveLength(0)
        side.exec('DROP TRIGGER fail_insert')
      } finally {
        side.close()
      }
      expect((await post()).status).toBe(202)
      expect(rows()).toHaveLength(1)
    })

    it('answers 503 when the queue is full and 2xx for a duplicate at capacity', async () => {
      await ingress.stop()
      ledger.close()
      ledger = harness.open({ webhookQueueLimits: { maxPending: 1, maxQueuedBytes: 1024 } })
      connectBinding()
      await startIngress()
      expect((await post({ headers: stableHeaders('m-1') })).status).toBe(202)
      expect((await post({ headers: stableHeaders('m-2') })).status).toBe(503)
      const duplicate = await post({ headers: stableHeaders('m-1') })
      expect(duplicate.status).toBe(202)
      expect(JSON.parse(duplicate.text)).toEqual({ code: 'duplicate' })
      expect(rows()).toHaveLength(1)
    })

    it('answers a duplicate after the disabled policy already finished its delivery', async () => {
      expect((await post()).status).toBe(202)
      const disabled = updateProjectEventPolicy(ledger.ledgerContext(), {
        repoId: 'repo-1',
        expectedGeneration: 1,
        patch: { enabled: false }
      })
      expect(disabled.ok).toBe(true)

      const retry = await post()

      expect(retry.status).toBe(202)
      expect(JSON.parse(retry.text)).toEqual({ code: 'duplicate' })
      // Nothing may decide a delivery whose policy is off, so it must not keep its slot or payload.
      expect(rows()).toMatchObject([{ state: 'failed', body: Buffer.alloc(0) }])
      expect(ledger.getWebhookQueueStatus().pending).toBe(0)
    })

    it('admits concurrent distinct deliveries up to the cap and no more', async () => {
      await ingress.stop()
      ledger.close()
      ledger = harness.open({ webhookQueueLimits: { maxPending: 3, maxQueuedBytes: 1024 } })
      connectBinding()
      await startIngress()
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) => post({ headers: stableHeaders(`c-${i}`) }))
      )
      expect(replies.filter((r) => r.status === 202)).toHaveLength(3)
      expect(rows()).toHaveLength(3)
    })
  })

  describe('lifecycle', () => {
    it('does not listen until given an explicit bind target', async () => {
      const idle = new ForgeWebhookIngress(ledger)
      expect(idle.status()).toMatchObject({ listening: false, port: null })
      await idle.stop()
    })

    it('surfaces a port already in use without substituting another', async () => {
      const blocker = net.createServer()
      blocker.listen(0, '127.0.0.1')
      await once(blocker, 'listening')
      const address = blocker.address()
      if (address === null || typeof address === 'string') {
        throw new Error('blocker did not bind a port')
      }
      const taken = address.port
      try {
        const clash = new ForgeWebhookIngress(ledger)
        await expect(clash.listen({ host: '127.0.0.1', port: taken })).rejects.toMatchObject({
          code: 'EADDRINUSE'
        })
        await clash.stop()
      } finally {
        blocker.close()
      }
    })

    async function freePort(): Promise<number> {
      const probe = net.createServer()
      probe.listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const address = probe.address()
      probe.close()
      await once(probe, 'close')
      if (address === null || typeof address === 'string') {
        throw new Error('probe did not bind a port')
      }
      return address.port
    }

    function refused(target: number): Promise<unknown> {
      return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: target })
        socket.once('connect', () => {
          socket.destroy()
          resolve(null)
        })
        socket.once('error', resolve)
      })
    }

    it('ends closed when stopped while the listener is still starting', async () => {
      const target = await freePort()
      const racing = new ForgeWebhookIngress(ledger)
      const started = racing.listen({ host: '127.0.0.1', port: target })
      const rejected = expect(started).rejects.toThrow()
      const stopped = racing.stop()
      await rejected
      await stopped
      expect(racing.status()).toMatchObject({ listening: false, port: null })
      expect(await refused(target)).toMatchObject({ code: 'ECONNREFUSED' })
    })

    it('closes the listener when the server reports a runtime error after listening', async () => {
      const created: http.Server[] = []
      const real = http.createServer
      const create = vi.spyOn(http, 'createServer')
      create.mockImplementation((...args: Parameters<typeof http.createServer>) => {
        const made = real(...args)
        created.push(made)
        return made
      })
      const failing = new ForgeWebhookIngress(ledger)
      const { port: bound } = await failing.listen({ host: '127.0.0.1', port: 0 })
      const [server] = created
      create.mockRestore()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      server.emit('error', new Error('runtime failure'))
      await vi.waitFor(async () =>
        expect(await refused(bound)).toMatchObject({ code: 'ECONNREFUSED' })
      )
      expect(failing.status().listening).toBe(false)
      await failing.stop()
    })

    it('settles both listen and stop when stopped before a bind error arrives', async () => {
      const blocker = net.createServer()
      blocker.listen(0, '127.0.0.1')
      await once(blocker, 'listening')
      const address = blocker.address()
      if (address === null || typeof address === 'string') {
        throw new Error('blocker did not bind a port')
      }
      try {
        const clash = new ForgeWebhookIngress(ledger)
        const started = clash.listen({ host: '127.0.0.1', port: address.port })
        const stopped = clash.stop()
        const bounded = <T>(work: Promise<T>) =>
          Promise.race([
            work.then(
              () => 'settled',
              () => 'settled'
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
          ])
        expect(await bounded(started)).toBe('settled')
        expect(await bounded(stopped)).toBe('settled')
        expect(clash.status().listening).toBe(false)
      } finally {
        blocker.close()
      }
    })

    it('stops idempotently, closes stalled sockets, and lets the ledger reopen', async () => {
      const stalled = await openRaw(port)
      stalled.on('error', () => undefined)
      const closed = closedOf(stalled)
      stalled.write(rawHead(path, 100))
      expect((await post()).status).toBe(202)

      await Promise.all([ingress.stop(), ingress.stop()])
      await closed
      await expect(post()).rejects.toBeDefined()
      await ingress.stop()

      ledger.close()
      ledger = harness.open()
      expect(rows()).toHaveLength(1)
    })
  })
})
