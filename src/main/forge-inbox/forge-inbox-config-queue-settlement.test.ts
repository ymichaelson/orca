import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const projects = (enabled42: boolean, rules = '') => [
  { projectId: '42', repoId: 'repo-1', enabled: enabled42, rules },
  { projectId: '43', repoId: 'repo-2', enabled: true }
]

describe('forge inbox config changes settle undeliverable raw queue rows', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: projects(true) })]))
    // Parked needs-auth rows for both projects plus one pending row for project 42.
    for (const [projectId, key] of [
      ['42', 'parked-42'],
      ['43', 'parked-43']
    ]) {
      admit(projectId, key)
      const claimed = ledger.claimNextWebhookDelivery(ledger.nowMs())
      if (!claimed) {
        throw new Error('nothing claimed')
      }
      ledger.markWebhookDeliveryNeedsAuth(claimed.id)
    }
    admit('42', 'pending-42')
  })
  afterEach(() => harness.dispose())

  function admit(projectId: string, key: string) {
    const result = ledger.admitWebhookDelivery({
      instanceId: INSTANCE_ID,
      projectId,
      expectedConfigRevision: ledger.getConfig().configRevision,
      eventKind: 'Note Hook',
      dedupeKey: key,
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{"fake":true}')
    })
    if (!result.ok) {
      throw new Error(result.reason)
    }
  }

  function rows() {
    const side = new Database(harness.dbPath)
    try {
      return side
        .prepare(
          `SELECT project_id, dedupe_key, state, length(body) AS body_bytes,
                  finished_at IS NOT NULL AS finished
           FROM webhook_deliveries ORDER BY id`
        )
        .all()
    } finally {
      side.close()
    }
  }
  const apply = (instances: Record<string, unknown>[]) =>
    ledger.updateConfig(ledger.getConfig().configRevision, webhookConfig(instances))

  it('settles the rows of a project that was disabled, keeps the other project, and frees capacity', () => {
    const pendingBefore = ledger.getWebhookQueueStatus().pending

    expect(apply([webhookInstance({ projects: projects(false) })]).ok).toBe(true)

    const settled = rows().filter((row) => row.project_id === '42')
    expect(settled).toHaveLength(2)
    expect(settled.every((row) => row.state === 'done' && row.body_bytes === 0)).toBe(true)
    expect(settled.every((row) => row.finished === 1)).toBe(true)
    expect(rows().find((row) => row.project_id === '43')).toMatchObject({
      state: 'needs-auth',
      body_bytes: 13
    })
    expect(ledger.getWebhookQueueStatus().pending).toBe(pendingBefore - 2)
  })

  it('settles every row of a removed project and of a removed instance, clearing credentials but keeping the origin binding', () => {
    expect(apply([webhookInstance({ projects: [projects(true)[1]] })]).ok).toBe(true)
    expect(
      rows()
        .filter((row) => row.project_id === '42')
        .map((row) => row.state)
    ).toEqual(['done', 'done'])

    expect(apply([]).ok).toBe(true)
    expect(rows().every((row) => row.state === 'done' && row.body_bytes === 0)).toBe(true)
    expect(ledger.getConfig().credentials).toEqual([])
    const side = new Database(harness.dbPath)
    expect(side.prepare('SELECT instance_id FROM instance_origins').all()).toHaveLength(1)
    side.close()
  })

  it('leaves raw rows alone for edits that keep the project active', () => {
    const before = rows()

    expect(apply([webhookInstance({ projects: projects(true, 'new rules') })]).ok).toBe(true)

    expect(rows()).toEqual(before)
  })

  it('rolls config, proposal revocation and raw settlement back together and emits no hint', async () => {
    const ingested = ledger.ingestEvent({
      hostId: 'host-a',
      instanceId: INSTANCE_ID,
      projectId: '42',
      kind: 'merge_request',
      iid: 1,
      dedupeKey: 'item-1',
      eventKind: 'merge_request.updated',
      payload: {},
      versionToken: 'v1',
      sourceOrder: 1,
      title: 't',
      itemState: 'opened',
      queueRun: { reason: 'x' }
    })
    const claimed = ledger.claimNextQueuedRun({ instanceId: INSTANCE_ID })
    if (ingested.duplicate || !claimed) {
      throw new Error('no run claimed')
    }
    const made = ledger.createProposal({
      runId: claimed.id,
      expectedGeneration: claimed.generation,
      body: { comment: 'hi' }
    })
    if (!made.ok) {
      throw new Error(made.reason)
    }
    const side = new Database(harness.dbPath)
    side.exec(`CREATE TRIGGER fail_revoke BEFORE INSERT ON changes WHEN NEW.entity = 'proposal'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`)
    side.close()
    const hints: unknown[] = []
    ledger.onCommitted((hint) => hints.push(hint))
    const config = ledger.getConfig()
    const raw = rows()

    expect(() => apply([webhookInstance({ projects: projects(false) })])).toThrow(/injected/)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(ledger.getConfig()).toEqual(config)
    expect(rows()).toEqual(raw)
    expect(ledger.getProposal(made.proposal.id)?.status).toBe('pending')
    expect(hints).toEqual([])
  })
})
