export * from './forge-inbox-gitlab-fake-server'
import { createFakeGitlab } from './forge-inbox-gitlab-fake-server'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createForgeWebhookWorker,
  type ForgeWebhookWorkerLedger
} from './forge-inbox-webhook-worker'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance
} from './forge-inbox-webhook-test-harness'

export const API_TOKEN = 'glpat-worker-api-token'
export const SECRET_TEXT = 'confidential-note-text-9f3'

const HOOK_HEADER: Record<string, string> = {
  merge_request: 'Merge Request Hook',
  note: 'Note Hook',
  pipeline: 'Pipeline Hook',
  issue: 'Issue Hook',
  push: 'Push Hook'
}

type ProjectOverrides = Record<string, unknown>

export function createWorkerRig(
  options: { project?: ProjectOverrides; usernames?: string[]; apiToken?: string | null } = {}
) {
  const harness = createWebhookHarness()
  const gitlab = createFakeGitlab()
  let ledger: ForgeInboxLedger = harness.open()
  let admitted = 0

  const projectPolicy = (overrides: ProjectOverrides = {}) => ({
    projectId: PROJECT_ID,
    repoId: 'repo-1',
    enabled: true,
    automaticAnalysis: true,
    agentId: 'agent',
    model: 'model',
    events: {
      reviewRequests: true,
      participatingMergeRequestUpdates: true,
      pipelineFailures: true,
      issueMentions: true,
      issueAssignments: true
    },
    ...overrides
  })
  const instanceConfig = (
    overrides: ProjectOverrides = {},
    usernames = options.usernames ?? ['me']
  ) =>
    webhookConfig([
      webhookInstance({
        usernames,
        projects: [projectPolicy({ ...options.project, ...overrides })]
      })
    ])

  harness.configure(ledger, instanceConfig())
  if (options.apiToken !== null) {
    writeApiToken(options.apiToken ?? API_TOKEN)
  }

  function writeApiToken(secret: string) {
    const stored = ledger.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret,
      expectedRevision: ledger.getConfig().configRevision
    })
    if (!stored.ok) {
      throw new Error(`api credential rejected: ${stored.reason}`)
    }
  }

  const db = () => new Database(harness.dbPath)
  const rows = (sql: string, ...args: string[]) => {
    const connection = db()
    try {
      return connection.prepare(sql).all(...args)
    } finally {
      connection.close()
    }
  }

  return {
    harness,
    gitlab,
    get ledger() {
      return ledger
    },
    writeApiToken,
    reconfigure(overrides: ProjectOverrides = {}, usernames?: string[]) {
      const updated = ledger.updateConfig(
        ledger.getConfig().configRevision,
        instanceConfig(overrides, usernames)
      )
      if (!updated.ok) {
        throw new Error(`config rejected: ${updated.reason}`)
      }
    },
    /** Models a process restart: the ledger reopens on the same file. */
    restart() {
      ledger.close()
      ledger = harness.open()
      return ledger
    },
    admit(kind: keyof typeof HOOK_HEADER, body: unknown, rawBody?: string) {
      admitted += 1
      const result = ledger.admitWebhookDelivery({
        instanceId: INSTANCE_ID,
        projectId: PROJECT_ID,
        expectedConfigRevision: ledger.getConfig().configRevision,
        eventKind: HOOK_HEADER[kind],
        dedupeKey: `delivery-${admitted}`,
        correlation: { eventUuid: null, configUuid: null },
        body: Buffer.from(rawBody ?? JSON.stringify(body))
      })
      if (!result.ok) {
        throw new Error(`admit failed: ${result.reason}`)
      }
      return result.deliveryId
    },
    worker(wrap?: (real: ForgeInboxLedger) => ForgeWebhookWorkerLedger) {
      return createForgeWebhookWorker({
        ledger: wrap ? wrap(ledger) : ledger,
        http: { fetch: (url) => gitlab.fetch(url) }
      })
    },
    advance: (ms: number) => harness.advanceClock(ms),
    deliveries: () =>
      rows(
        'SELECT id, state, attempts, next_attempt_at, last_error_code, length(body) AS body_bytes FROM webhook_deliveries WHERE host_id = ? ORDER BY id',
        ledger.hostId
      ),
    items: () => rows('SELECT * FROM items ORDER BY id'),
    revisions: () =>
      rows('SELECT item_id, revision, version_token, source_order FROM item_revisions ORDER BY id'),
    events: () =>
      rows('SELECT id, revision, source_order, payload_json FROM events ORDER BY id').map((row) => {
        const payload: unknown = JSON.parse(String(row.payload_json))
        return { id: Number(row.id), sourceOrder: Number(row.source_order), payload }
      }),
    runs: () => rows('SELECT state, revision FROM runs ORDER BY id'),
    dispose: () => harness.dispose()
  }
}

export type WorkerRig = ReturnType<typeof createWorkerRig>

/** Wraps a real ledger so one method can fail like a dying process while the rest stay real. */
export function overrideLedger(
  real: ForgeInboxLedger,
  overrides: Record<string, (...args: never[]) => unknown>
): ForgeInboxLedger {
  return new Proxy(real, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(overrides, key)) {
        return overrides[key]
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
