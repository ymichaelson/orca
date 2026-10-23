import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { ForgeWebhookIngress } from './forge-inbox-webhook-ingress'
import {
  createWebhookHarness,
  fakeSecretStore,
  INSTANCE_ID,
  PROJECT_ID,
  WEBHOOK_TOKEN,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const PATH = `/webhooks/gitlab/${INSTANCE_ID}`
const NOTE = JSON.stringify({ object_kind: 'note', project: { id: Number(PROJECT_ID) } })

type Reply = { status: number; text: string }

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
  options: {
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string
  }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? PATH,
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

function rawHead(contentLength: number, headers = stableHeaders('m-raw')): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  return `POST ${PATH} HTTP/1.1\r\nHost: x\r\ncontent-length: ${contentLength}\r\n${lines.join('\r\n')}\r\n\r\n`
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
  let port: number

  async function startIngress(options: ConstructorParameters<typeof ForgeWebhookIngress>[1] = {}) {
    ingress = new ForgeWebhookIngress(ledger, options)
    port = (await ingress.listen({ host: '127.0.0.1', port: 0 })).port
  }

  const rows = () => ledger.listWebhookDeliveries({ limit: 100 })

  beforeEach(async () => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
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
      const reply = await send(port, { body: NOTE })
      expect(reply.status).toBe(202)
      expect(rows()).toHaveLength(1)

      await ingress.stop()
      ledger.close()
      ledger = harness.open()
      const [row] = rows()
      expect(row).toMatchObject({
        instanceId: INSTANCE_ID,
        projectId: PROJECT_ID,
        eventKind: 'Note Hook',
        eventUuid: 'evt-1',
        configUuid: 'cfg-1'
      })
      expect(row.body.toString()).toBe(NOTE)
      expect(JSON.stringify(row)).not.toContain(WEBHOOK_TOKEN)
    })

    it('dedupes a GitLab retry across restart without storing the retry', async () => {
      await send(port, { body: NOTE })
      await ingress.stop()
      ledger.close()
      ledger = harness.open()
      await startIngress()

      const retry = await send(port, { body: NOTE.replace('note', 'note ') })
      expect(retry.status).toBe(202)
      const stored = rows()
      expect(stored).toHaveLength(1)
      expect(stored[0].body.toString()).toBe(NOTE)
    })

    it('does not merge deliveries that share config and event UUIDs but differ in message id', async () => {
      await send(port, { headers: stableHeaders('m-1'), body: NOTE })
      await send(port, { headers: stableHeaders('m-2'), body: NOTE.replace('note', 'note2') })
      expect(rows().map((r) => r.dedupeKey)).toHaveLength(2)
    })

    it('accepts Idempotency-Key as the legacy alias and prefers webhook-id', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      await send(port, { headers: { ...noId, 'idempotency-key': 'legacy-1' } })
      await send(port, { headers: { ...noId, 'idempotency-key': 'legacy-1' } })
      expect(rows()).toHaveLength(1)

      await send(port, { headers: stableHeaders('wh-9', { 'idempotency-key': 'legacy-1' }) })
      expect(rows()).toHaveLength(2)
    })

    it('treats webhook-id and Idempotency-Key as one identity namespace', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      await send(port, { headers: stableHeaders('same-7') })
      const migrated = await send(port, { headers: { ...noId, 'idempotency-key': 'same-7' } })
      expect(migrated.status).toBe(202)
      expect(rows()).toHaveLength(1)
    })

    it('refuses a delivery with no stable message id unless the instance opted into digest dedupe', async () => {
      const { 'webhook-id': _drop, ...noId } = stableHeaders('x')
      const refused = await send(port, { headers: noId })
      expect(refused.status).toBe(400)
      expect(JSON.parse(refused.text)).toEqual({ code: 'missing-delivery-id' })
      expect(rows()).toHaveLength(0)

      const optIn = webhookConfig([webhookInstance({ allowLegacyPayloadDigestDedupe: true })])
      const revision = ledger.getConfig().configRevision
      const updated = ledger.updateConfig(revision, optIn)
      expect(updated.ok).toBe(true)
      expect((await send(port, { headers: noId })).status).toBe(202)
      expect((await send(port, { headers: noId })).status).toBe(202)
      expect(rows()).toHaveLength(1)
      const changed = await send(port, { headers: noId, body: NOTE.replace('note', 'note3') })
      expect(changed.status).toBe(202)
      expect(rows()).toHaveLength(2)
    })

    it('refuses ambiguous duplicate identity headers', async () => {
      const socket = await openRaw(port)
      const head = rawHead(NOTE.length, stableHeaders('m-1')).replace(
        '\r\n\r\n',
        '\r\nwebhook-id: m-2\r\n\r\n'
      )
      socket.write(head + NOTE)
      const text = await readUntilClose(socket)
      expect(text).toMatch(/^HTTP\/1\.1 400 /)
      expect(rows()).toHaveLength(0)
    })
  })

  describe('rejections never leave a row or a run', () => {
    const cases: [string, () => Promise<Reply>, number][] = [
      [
        'wrong token',
        () => send(port, { headers: stableHeaders('a', { 'x-gitlab-token': 'nope' }) }),
        401
      ],
      [
        'longer wrong token',
        () => send(port, { headers: stableHeaders('a', { 'x-gitlab-token': 'x'.repeat(5000) }) }),
        401
      ],
      [
        'missing token',
        () => {
          const { 'x-gitlab-token': _t, ...rest } = stableHeaders('a')
          return send(port, { headers: rest })
        },
        401
      ],
      ['unknown instance', () => send(port, { path: '/webhooks/gitlab/other' }), 404],
      ['query target override', () => send(port, { path: `${PATH}?instance=other` }), 404],
      ['wrong path', () => send(port, { path: '/hooks' }), 404],
      ['GET', () => send(port, { method: 'GET', body: '' }), 405],
      [
        'text/plain',
        () => send(port, { headers: stableHeaders('a', { 'content-type': 'text/plain' }) }),
        415
      ],
      ['malformed JSON', () => send(port, { body: '{"project":' }), 400],
      ['invalid UTF-8', () => send(port, { body: Buffer.from([0x7b, 0xff, 0x7d]) }), 400],
      ['array body', () => send(port, { body: '[1]' }), 400],
      ['unconfigured project', () => send(port, { body: '{"project":{"id":777}}' }), 422],
      [
        'unsafe project id',
        () => send(port, { body: '{"project":{"id":99999999999999999999}}' }),
        400
      ],
      [
        'conflicting project ids',
        () => send(port, { body: `{"project_id":${PROJECT_ID},"project":{"id":43}}` }),
        400
      ],
      ['no project id', () => send(port, { body: '{"object_kind":"note"}' }), 400]
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
      const reply = await send(port, { body: bom })
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.text)).toEqual({ code: 'invalid-body' })
      expect(rows()).toHaveLength(0)
    })

    it('answers a missing token 401 without consulting storage', async () => {
      ledger.close()
      const { 'x-gitlab-token': _t, ...rest } = stableHeaders('a')
      expect((await send(port, { headers: rest })).status).toBe(401)
      expect(
        (await send(port, { headers: stableHeaders('a', { 'x-gitlab-token': '' }) })).status
      ).toBe(401)
    })

    it('rejects a delivery for a disabled project', async () => {
      const disabled = webhookInstance({
        projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: false }]
      })
      harness.configure(ledger, webhookConfig([disabled]))
      const reply = await send(port, {})
      expect(reply.status).toBe(422)
      expect(JSON.parse(reply.text)).toEqual({ code: 'project-disabled' })
      expect(rows()).toHaveLength(0)
    })

    it('reports an absent webhook credential as unavailable without admitting', async () => {
      ledger.clearCredential({
        instanceId: INSTANCE_ID,
        kind: 'webhook',
        expectedRevision: ledger.getConfig().configRevision
      })
      const reply = await send(port, {})
      expect(reply.status).toBe(503)
      expect(reply.text).not.toContain(WEBHOOK_TOKEN)
      expect(rows()).toHaveLength(0)
    })

    it('reports an undecryptable credential as unavailable and never falls back', async () => {
      await ingress.stop()
      ledger.close()
      ledger = ledgerWithOtherKey()
      await startIngress()
      const reply = await send(port, {})
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
      socket.write(rawHead(2 * 1024 * 1024))
      const text = await readUntilClose(socket)
      expect(text).toMatch(/^HTTP\/1\.1 413/)
      expect(rows()).toHaveLength(0)
    })

    it('rejects an oversized chunked body', async () => {
      const socket = await openRaw(port)
      const head = rawHead(0).replace('content-length: 0\r\n', 'transfer-encoding: chunked\r\n')
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
      socket.write(rawHead(100))
      socket.write('{')
      await closed
      expect(rows()).toHaveLength(0)
    })

    it('drops a slow partial header block at the absolute deadline from connect', async () => {
      await ingress.stop()
      await startIngress({ requestDeadlineMs: 120 })
      const socket = await openRaw(port)
      const closed = closedOf(socket)
      socket.write('POST /webhooks/gitlab/gitlab-main HTTP/1.1\r\nHost: x\r\nx-slow: ')
      await closed
      expect(rows()).toHaveLength(0)
    })

    it('does not extend the deadline when a client trickles bytes', async () => {
      await ingress.stop()
      await startIngress({ requestDeadlineMs: 150 })
      const socket = await openRaw(port)
      const closed = closedOf(socket)
      socket.on('error', () => undefined)
      socket.write(rawHead(1000))
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
        s.write(rawHead(100))
      }
      await vi.waitFor(() => expect(ingress.status().inFlight).toBe(2))
      const refused = await send(port, {})
      expect(refused.status).toBe(503)
      expect(rows()).toHaveLength(0)

      await Promise.all(closes)
      expect((await send(port, {})).status).toBe(202)
    })
  })

  describe('stale authentication', () => {
    async function partialThen(change: () => void): Promise<string> {
      const socket = await openRaw(port)
      const reply = readUntilClose(socket)
      socket.write(rawHead(NOTE.length))
      socket.write(NOTE.slice(0, 5))
      await vi.waitFor(() => expect(ingress.status().inFlight).toBe(1))
      change()
      socket.write(NOTE.slice(5))
      return reply
    }

    it('does not commit when the webhook secret rotates during the body', async () => {
      const text = await partialThen(() => {
        ledger.setCredential({
          instanceId: INSTANCE_ID,
          kind: 'webhook',
          secret: 'rotated-token',
          expectedRevision: ledger.getConfig().configRevision
        })
      })
      expect(text).toMatch(/^HTTP\/1\.1 503 /)
      expect(rows()).toHaveLength(0)
    })

    it('does not commit when the project is removed during the body', async () => {
      const text = await partialThen(() => {
        harness.configure(ledger, webhookConfig([webhookInstance({ projects: [] })]))
      })
      expect(text).toMatch(/^HTTP\/1\.1 503 /)
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
        const failed = await send(port, {})
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
      expect((await send(port, {})).status).toBe(202)
      expect(rows()).toHaveLength(1)
    })

    it('answers 503 when the queue is full and 2xx for a duplicate at capacity', async () => {
      await ingress.stop()
      ledger.close()
      ledger = harness.open({ webhookQueueLimits: { maxPending: 1, maxQueuedBytes: 1024 } })
      await startIngress()
      expect((await send(port, { headers: stableHeaders('m-1') })).status).toBe(202)
      expect((await send(port, { headers: stableHeaders('m-2') })).status).toBe(503)
      expect((await send(port, { headers: stableHeaders('m-1') })).status).toBe(202)
      expect(rows()).toHaveLength(1)
    })

    it('settles a stored delivery when its project is disabled and rejects its duplicate, storing nothing', async () => {
      expect((await send(port, {})).status).toBe(202)
      harness.configure(
        ledger,
        webhookConfig([
          webhookInstance({
            projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: false }]
          })
        ])
      )
      const retry = await send(port, {})
      expect(retry.status).toBe(422)
      expect(JSON.parse(retry.text)).toEqual({ code: 'project-disabled' })
      expect(rows()).toHaveLength(0)
      expect(ledger.getWebhookQueueStatus().pending).toBe(0)
    })

    it('admits concurrent distinct deliveries up to the cap and no more', async () => {
      await ingress.stop()
      ledger.close()
      ledger = harness.open({ webhookQueueLimits: { maxPending: 3, maxQueuedBytes: 1024 } })
      await startIngress()
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) => send(port, { headers: stableHeaders(`c-${i}`) }))
      )
      expect(replies.filter((r) => r.status === 202)).toHaveLength(3)
      expect(rows()).toHaveLength(3)
    })
  })

  describe('lifecycle', () => {
    it('does not listen when the persisted listener is disabled', async () => {
      const idle = new ForgeWebhookIngress(ledger)
      expect(await idle.start()).toEqual({ listening: false })
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

        const config = ledger.getConfig()
        const enabled = webhookConfig([webhookInstance()], {
          enabled: true,
          bindAddress: '127.0.0.1',
          port: taken
        })
        const updated = ledger.updateConfig(config.configRevision, enabled)
        expect(updated.ok).toBe(true)
        const viaConfig = new ForgeWebhookIngress(ledger)
        await expect(viaConfig.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
        await viaConfig.stop()
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
      stalled.write(rawHead(100))
      expect((await send(port, {})).status).toBe(202)

      await Promise.all([ingress.stop(), ingress.stop()])
      await closed
      await expect(send(port, {})).rejects.toBeDefined()
      await ingress.stop()

      ledger.close()
      ledger = harness.open()
      expect(rows()).toHaveLength(1)
    })
  })
})
