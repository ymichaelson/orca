import http from 'node:http'
import type net from 'node:net'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { forgeErrorLabel } from './forge-inbox-error-label'
import { readWebhookBody } from './forge-inbox-webhook-body-reader'
import { authenticateWebhookRequest } from './forge-inbox-webhook-auth'
import {
  legacyDigestDedupeKey,
  messageDedupeKey,
  parseWebhookBody,
  WEBHOOK_REJECTIONS
} from './forge-inbox-webhook-request'

const MAX_HEADER_BYTES = 16 * 1024
const MAX_HEADER_COUNT = 64

export type ForgeWebhookIngressOptions = {
  /** Absolute budget from TCP connect to the end of the response; never reset by activity. */
  requestDeadlineMs?: number
  maxConcurrentRequests?: number
  /** How long stop() lets in-flight requests finish before their sockets are destroyed. */
  shutdownGraceMs?: number
  /** Runs after a new delivery commits; its failure never changes the already-decided reply. */
  onAdmitted?: () => void
}

export type ForgeWebhookIngressStatus = {
  listening: boolean
  port: number | null
  inFlight: number
}

type ListenTarget = { host: string; port: number }
type Stage = 'idle' | 'starting' | 'listening' | 'stopped'

/** Independent GitLab webhook listener; 2xx is sent only after the delivery is committed to SQLite. */
export class ForgeWebhookIngress {
  private readonly deadlineMs: number
  private readonly maxConcurrent: number
  private readonly graceMs: number
  private readonly onAdmitted: (() => void) | undefined
  private stage: Stage = 'idle'
  private server: http.Server | null = null
  private starting: Promise<{ port: number }> | null = null
  private stopping: Promise<void> | null = null
  private readonly sockets = new Set<net.Socket>()
  private readonly busySockets = new Set<net.Socket>()
  private readonly openedAt = new WeakMap<net.Socket, number>()
  private inFlight = 0
  private drained: (() => void) | null = null

  constructor(
    private readonly ledger: ForgeInboxLedger,
    options: ForgeWebhookIngressOptions = {}
  ) {
    this.deadlineMs = options.requestDeadlineMs ?? 5000
    this.maxConcurrent = options.maxConcurrentRequests ?? 16
    this.graceMs = options.shutdownGraceMs ?? 1000
    this.onAdmitted = options.onAdmitted
  }

  /** Binds the persisted listener config; a disabled listener never touches the network. */
  async start(): Promise<{ listening: false } | { listening: true; port: number }> {
    const { listener } = this.ledger.getConfig().config
    if (!listener.enabled) {
      return { listening: false }
    }
    const { port } = await this.listen({ host: listener.bindAddress, port: listener.port })
    return { listening: true, port }
  }

  /** Exact host and port, no fallback; port 0 is for tests, config validation keeps 1..65535. */
  listen(target: ListenTarget): Promise<{ port: number }> {
    if (this.stage !== 'idle') {
      return Promise.reject(new Error('forge webhook ingress cannot be started again'))
    }
    this.stage = 'starting'
    const server = this.createServer()
    this.server = server
    this.starting = new Promise((resolve, reject) => {
      server.on('error', (error) => {
        // Rejecting is a no-op once settled; unsettled, it frees a stop() waiting on the bind.
        reject(error)
        if (this.stage === 'starting') {
          this.stage = 'stopped'
          this.destroySockets()
          return
        }
        console.warn('[forge-inbox] webhook listener error')
        void this.stop()
      })
      server.listen({ host: target.host, port: target.port, exclusive: true }, () => {
        const address = server.address()
        if (this.stage !== 'starting') {
          reject(new Error('forge webhook ingress stopped while starting'))
        } else if (address === null || typeof address === 'string') {
          reject(new Error('forge webhook ingress has no TCP address'))
        } else {
          this.stage = 'listening'
          resolve({ port: address.port })
        }
      })
    })
    return this.starting
  }

  status(): ForgeWebhookIngressStatus {
    const address = this.server?.address()
    return {
      listening: this.stage === 'listening',
      port: address && typeof address !== 'string' ? address.port : null,
      inFlight: this.inFlight
    }
  }

  /** Idempotent: stop accepting, let in-flight commits finish within the grace, then close. */
  stop(): Promise<void> {
    this.stopping ??= this.shutDown()
    return this.stopping
  }

  private async shutDown(): Promise<void> {
    const wasIdle = this.stage === 'idle'
    this.stage = 'stopped'
    await this.starting?.catch(() => undefined)
    const server = this.server
    if (wasIdle || !server) {
      return
    }
    const closed = new Promise<void>((resolve) => {
      if (server.listening) {
        server.close(() => resolve())
      } else {
        resolve()
      }
    })
    for (const socket of this.sockets) {
      if (!this.busySockets.has(socket)) {
        socket.destroy()
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.graceMs)
      this.drained = () => {
        clearTimeout(timer)
        resolve()
      }
      if (this.inFlight === 0) {
        this.drained()
      }
    })
    this.destroySockets()
    await closed
  }

  private destroySockets(): void {
    for (const socket of this.sockets) {
      socket.destroy()
    }
  }

  private createServer(): http.Server {
    const server = http.createServer(
      {
        maxHeaderSize: MAX_HEADER_BYTES,
        headersTimeout: this.deadlineMs,
        requestTimeout: this.deadlineMs,
        connectionsCheckingInterval: Math.max(50, Math.min(1000, this.deadlineMs / 2)),
        keepAliveTimeout: 1
      },
      (req, res) => this.handle(req, res)
    )
    server.maxHeadersCount = MAX_HEADER_COUNT
    server.maxConnections = this.maxConcurrent * 2
    server.on('connection', (socket) => this.track(socket))
    server.on('clientError', (_error, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } else {
        socket.destroy()
      }
    })
    return server
  }

  private track(socket: net.Socket): void {
    if (this.stage === 'stopped') {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    this.openedAt.set(socket, performance.now())
    socket.on('error', () => undefined)
    const timer = setTimeout(() => socket.destroy(), this.deadlineMs)
    timer.unref()
    socket.once('close', () => {
      clearTimeout(timer)
      this.sockets.delete(socket)
      this.busySockets.delete(socket)
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.inFlight++
    this.busySockets.add(req.socket)
    res.once('close', () => {
      this.inFlight--
      this.busySockets.delete(req.socket)
      if (this.stage === 'stopped' && this.inFlight === 0) {
        this.drained?.()
      }
    })
    const reply = (status: number, code: string, keepOpen = false) => {
      if (res.headersSent) {
        return
      }
      const body = JSON.stringify({ code })
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(keepOpen ? {} : { connection: 'close' })
      })
      res.end(body)
    }
    if (this.stage === 'stopped' || this.inFlight > this.maxConcurrent) {
      reply(503, 'busy')
      return
    }
    this.route(req, reply)
  }

  private route(
    req: http.IncomingMessage,
    reply: (status: number, code: string, keepOpen?: boolean) => void
  ): void {
    const auth = authenticateWebhookRequest(this.ledger, req)
    if (!auth.ok) {
      return reply(auth.status, auth.code)
    }
    const { instanceId, eventKind, messageId, correlation } = auth
    readWebhookBody(req, reply, (body) => {
      const parsed = parseWebhookBody(body)
      if (!parsed.ok) {
        return reply(400, 'invalid-body')
      }
      const dedupeKey =
        messageId === null
          ? legacyDigestDedupeKey(parsed.projectId, eventKind, body)
          : messageDedupeKey(messageId)
      if (this.deadlineExceeded(req.socket)) {
        return reply(503, 'deadline-exceeded')
      }
      try {
        // Synchronous SQLite can block the loop up to the ledger busy timeout; no worker by design.
        const result = this.ledger.admitWebhookDelivery({
          instanceId,
          projectId: parsed.projectId,
          expectedConfigRevision: auth.configRevision,
          eventKind,
          dedupeKey,
          correlation,
          body
        })
        if (result.ok) {
          if (!result.duplicate) {
            this.wake()
          }
          return reply(202, result.duplicate ? 'duplicate' : 'queued')
        }
        const [status, code] = WEBHOOK_REJECTIONS[result.reason]
        reply(status, code)
      } catch (error) {
        console.warn('[forge-inbox] webhook admission failed', forgeErrorLabel(error))
        reply(500, 'storage-failed')
      }
    })
  }

  private wake(): void {
    try {
      this.onAdmitted?.()
    } catch (error) {
      console.warn('[forge-inbox] webhook wake failed', forgeErrorLabel(error))
    }
  }

  private deadlineExceeded(socket: net.Socket): boolean {
    return performance.now() - (this.openedAt.get(socket) ?? performance.now()) >= this.deadlineMs
  }
}
