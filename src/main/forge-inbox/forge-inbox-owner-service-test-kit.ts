import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../sqlite/sync-database'
import { createFakeGitlab, type FakeGitlab } from './forge-inbox-gitlab-fake-server'
import { createForgeInboxOwnerService } from './forge-inbox-owner-service'
import {
  fakeSecretStore,
  INSTANCE_ID,
  PROJECT_ID,
  WEBHOOK_TOKEN,
  webhookConfig,
  webhookInstance
} from './forge-inbox-webhook-test-harness'
import {
  connectRefused,
  freePort,
  holdPort,
  openIdleSocket
} from './forge-inbox-owner-service-test-ports'

export { connectRefused, freePort, holdPort, openIdleSocket }

export const HOOK_PATH = `/webhooks/gitlab/${INSTANCE_ID}`
export const API_READ_TOKEN = 'glpat-owner-read'

type OwnerService = ReturnType<typeof createForgeInboxOwnerService>
type OwnerOptions = Partial<Parameters<typeof createForgeInboxOwnerService>[0]>

export function listenerOn(port: number, bindAddress = '127.0.0.1') {
  return {
    enabled: true,
    bindAddress,
    port,
    acknowledgeExternalPlaintextHttp: bindAddress !== '127.0.0.1'
  }
}

export function ownerConfig(
  listener: Record<string, unknown>,
  project: Record<string, unknown> = {}
) {
  return webhookConfig(
    [
      webhookInstance({
        usernames: ['me'],
        projects: [
          {
            projectId: PROJECT_ID,
            repoId: 'repo-1',
            enabled: true,
            automaticAnalysis: false,
            events: {
              reviewRequests: true,
              participatingMergeRequestUpdates: true,
              pipelineFailures: true,
              issueMentions: true,
              issueAssignments: true
            },
            ...project
          }
        ]
      })
    ],
    listener
  )
}

export function hookHeaders(
  id: string,
  token = WEBHOOK_TOKEN,
  event = 'Merge Request Hook'
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-gitlab-token': token,
    'x-gitlab-event': event,
    'webhook-id': id,
    'x-gitlab-webhook-uuid': 'cfg-1',
    'x-gitlab-event-uuid': `evt-${id}`
  }
}

export function postHook(
  port: number,
  body: unknown,
  id: string,
  token = WEBHOOK_TOKEN,
  event = 'Merge Request Hook'
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: HOOK_PATH,
        method: 'POST',
        headers: hookHeaders(id, token, event),
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
    req.end(JSON.stringify(body))
  })
}

/** Fake GitLab transport that can hold requests open and honours the caller's abort signal. */
export function createGateHttp(gitlab: FakeGitlab) {
  let held = false
  let releaseHeld: () => void = () => undefined
  let heldGate: Promise<void> = Promise.resolve()
  let holdAbort = false
  let releaseAbort: () => void = () => undefined
  let abortGate: Promise<void> = Promise.resolve()
  let markBlocked: () => void = () => undefined
  let markAborted: () => void = () => undefined
  let blocked = new Promise<void>((resolve) => (markBlocked = resolve))
  let aborted = new Promise<void>((resolve) => (markAborted = resolve))
  return {
    http: {
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        if (held) {
          markBlocked()
          const signal = init?.signal
          await new Promise<void>((resolve, reject) => {
            void heldGate.then(resolve)
            signal?.addEventListener('abort', () => {
              // The request's own timeout is not the owner cancelling it.
              if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
                return
              }
              markAborted()
              void abortGate.then(() => reject(new DOMException('aborted', 'AbortError')))
            })
          })
        }
        return gitlab.fetch(url, init)
      }
    },
    hold() {
      held = true
      heldGate = new Promise<void>((resolve) => (releaseHeld = resolve))
      blocked = new Promise<void>((resolve) => (markBlocked = resolve))
      aborted = new Promise<void>((resolve) => (markAborted = resolve))
    },
    release() {
      held = false
      releaseHeld()
    },
    /** After this, an aborted request only fails once releaseAbortedRequests() runs. */
    delayAbortCompletion() {
      holdAbort = true
      abortGate = new Promise<void>((resolve) => (releaseAbort = resolve))
    },
    releaseAbortedRequests() {
      if (holdAbort) {
        releaseAbort()
      }
    },
    requestBlocked: () => blocked,
    abortObserved: () => aborted
  }
}

export function createOwnerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-'))
  const dbPath = join(root, 'forge-inbox.db')
  const store = fakeSecretStore()
  const gitlab = createFakeGitlab()
  const gate = createGateHttp(gitlab)
  const services: OwnerService[] = []
  return {
    root,
    dbPath,
    store,
    gitlab,
    gate,
    service(options: OwnerOptions = {}): OwnerService {
      const created = createForgeInboxOwnerService({
        dbPath,
        http: gate.http,
        secretStore: store,
        ingress: { requestDeadlineMs: 30_000, shutdownGraceMs: 200 },
        ...options
      })
      services.push(created)
      return created
    },
    rows(sql: string, ...args: (string | number)[]) {
      const connection = new Database(dbPath)
      try {
        return connection.prepare(sql).all(...args)
      } finally {
        connection.close()
      }
    },
    deliveries() {
      return this.rows(
        'SELECT id, state, attempts, next_attempt_at, length(body) AS body_bytes FROM webhook_deliveries ORDER BY id'
      )
    },
    items() {
      return this.rows('SELECT id, kind, iid FROM items ORDER BY id')
    },
    async dispose() {
      for (const created of services) {
        await created.stop().catch(() => undefined)
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

export type OwnerFixture = ReturnType<typeof createOwnerFixture>

/** Applies config and credentials through the service so every step goes through its reconcile. */
export async function provision(
  service: OwnerService,
  listener: Record<string, unknown>,
  options: { apiRead?: string | null; project?: Record<string, unknown> } = {}
): Promise<void> {
  const updated = await service.updateConfig(
    service.getConfig().configRevision,
    ownerConfig(listener, options.project)
  )
  if (!updated.ok) {
    throw new Error(`config rejected: ${updated.reason}`)
  }
  const secrets: ['webhook' | 'api-read', string | null][] = [
    ['webhook', WEBHOOK_TOKEN],
    ['api-read', options.apiRead === undefined ? API_READ_TOKEN : options.apiRead]
  ]
  for (const [kind, secret] of secrets) {
    if (secret === null) {
      continue
    }
    const stored = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind,
      secret,
      expectedRevision: service.getConfig().configRevision
    })
    if (!stored.ok) {
      throw new Error(`credential rejected: ${stored.reason}`)
    }
  }
}

/** Creates the profile's ledger the way a prior run would have, then stops it. */
export async function seedLedger(
  fx: OwnerFixture,
  listener?: Record<string, unknown>
): Promise<{ port: number }> {
  const port = await freePort()
  const seed = fx.service()
  await seed.start()
  await provision(seed, listener ?? { enabled: false, bindAddress: '127.0.0.1', port })
  await seed.stop()
  return { port }
}

/** Makes the stored configuration unreadable so the next open of this ledger fails. */
export function damageLedger(fx: OwnerFixture): void {
  const damage = new Database(fx.dbPath)
  damage.prepare("UPDATE meta SET value = 'not json' WHERE key = 'config_json'").run()
  damage.close()
}

/**
 * Opens an authenticated hook request whose body never arrives. Resolves only once the server
 * has answered `100 Continue`, i.e. after it began handling the request, so the request is
 * provably in flight rather than still in the accept queue.
 */
export async function holdRequestMidBody(
  port: number,
  id: string
): Promise<{ release: () => void }> {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.on('error', () => undefined)
  const headers = Object.entries({
    ...hookHeaders(id),
    host: 'forge-test',
    expect: '100-continue',
    'content-length': '1000'
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => socket.write(`POST ${HOOK_PATH} HTTP/1.1\r\n${headers}\r\n\r\n`))
    socket.on('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 100')) {
        resolve()
      }
    })
    socket.once('close', () => reject(new Error('closed before 100 Continue')))
  })
  return { release: () => socket.destroy() }
}
