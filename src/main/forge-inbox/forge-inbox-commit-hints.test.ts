import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeEventIngest } from './forge-inbox-types'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }

type Hint = { changes: boolean; readClientIds: readonly string[] }

function event(overrides: Partial<ForgeEventIngest> = {}): ForgeEventIngest {
  return {
    hostId: 'host-a',
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    kind: 'merge_request',
    iid: 7,
    dedupeKey: 'delivery-1',
    eventKind: 'merge_request.updated',
    payload: { n: 1 },
    versionToken: 'v1',
    sourceOrder: 1,
    title: 'Add thing',
    itemState: 'opened',
    ...overrides
  }
}

// Hints are coalesced onto a microtask; a macrotask turn lets every queued one run.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('forge inbox post-commit hints', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let hints: Hint[]
  let side: Database.Database

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
    side = new Database(harness.dbPath)
    hints = []
    ledger.onCommitted((hint) => hints.push(hint))
  })
  afterEach(() => {
    side.close()
    harness.dispose()
  })

  function ingest(overrides: Partial<ForgeEventIngest> = {}) {
    const result = ledger.ingestEvent(event(overrides))
    if (result.duplicate) {
      throw new Error('unexpected duplicate')
    }
    return result
  }

  function pendingProposal(token = 'v1') {
    const { runId } = ingest({
      versionToken: token,
      dedupeKey: `d-${token}`,
      queueRun: { reason: 'x' }
    })
    const claimed = ledger.claimNextQueuedRun(SCOPE)
    if (!claimed || runId === null) {
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
    return made.proposal
  }

  const head = () => ledger.readChangeHead(SCOPE)

  it('delivers one metadata hint only after the commit is visible to another connection', async () => {
    const seenByOtherConnection: unknown[] = []
    ledger.onCommitted(() => {
      seenByOtherConnection.push(side.prepare('SELECT MAX(seq) AS seq FROM changes').get()?.seq)
    })

    ingest()
    expect(hints).toEqual([])
    await settle()

    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
    expect(seenByOtherConnection).toEqual([head()])
    expect(head()).toBeGreaterThan(0)
  })

  it('coalesces writes in one turn into a single hint', async () => {
    ingest()
    ingest({ dedupeKey: 'delivery-2', versionToken: 'v2', sourceOrder: 2 })
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
  })

  it('emits nothing for a failure after changes were recorded, then only the next write', async () => {
    side.exec(
      `CREATE TRIGGER fail_run_change BEFORE INSERT ON changes WHEN NEW.entity = 'run'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`
    )
    const before = head()

    expect(() => ingest({ queueRun: { reason: 'x' } })).toThrow(/injected/)
    await settle()
    expect(hints).toEqual([])
    expect(head()).toBe(before)

    side.exec('DROP TRIGGER fail_run_change')
    ingest({ dedupeKey: 'delivery-2', versionToken: 'v2', sourceOrder: 2 })
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
  })

  it('emits nothing when COMMIT itself fails', async () => {
    side.exec(
      `CREATE TABLE commit_gate_parent (id INTEGER PRIMARY KEY);
       CREATE TABLE commit_gate (
         parent INTEGER REFERENCES commit_gate_parent (id) DEFERRABLE INITIALLY DEFERRED
       );
       CREATE TRIGGER trip_commit AFTER INSERT ON changes
       BEGIN INSERT INTO commit_gate (parent) VALUES (999); END`
    )
    const before = head()

    expect(() => ingest()).toThrow(/FOREIGN KEY/i)
    await settle()
    expect(hints).toEqual([])
    expect(head()).toBe(before)
  })

  it('emits nothing for a duplicate delivery', async () => {
    ingest()
    await settle()
    hints.length = 0

    expect(ledger.ingestEvent(event()).duplicate).toBe(true)
    await settle()
    expect(hints).toEqual([])
  })

  it('isolates a throwing listener from the write and from other listeners', async () => {
    ledger.onCommitted(() => {
      throw new Error('listener bug')
    })

    expect(() => ingest()).not.toThrow()
    await settle()

    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes.length).toBeGreaterThan(0)
  })

  it('stops delivering after unsubscribe and drops pending hints on close', async () => {
    const late: Hint[] = []
    const unsubscribe = ledger.onCommitted((hint) => late.push(hint))
    unsubscribe()
    unsubscribe()

    ingest()
    ledger.close()
    await settle()

    expect(late).toEqual([])
    expect(hints).toEqual([])
  })

  it('hints run, proposal and receipt changes, and a policy bump that revokes a proposal', async () => {
    const proposal = pendingProposal()
    await settle()
    expect(hints.at(-1)).toEqual({ changes: true, readClientIds: [] })

    hints.length = 0
    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])

    const next = pendingProposal('v2')
    hints.length = 0
    expect(
      ledger.consumeProposal(next.id, {
        revision: next.revision,
        policyGeneration: next.policyGeneration
      }).ok
    ).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])

    hints.length = 0
    expect(ledger.beginReceipt({ proposalId: next.id }).started).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
    expect(proposal.id).not.toBe(next.id)
  })

  it('hints rejecting a pending proposal', async () => {
    const proposal = pendingProposal()
    await settle()
    hints.length = 0

    ledger.rejectProposal(proposal.id)
    await settle()
    expect(hints).toEqual([{ changes: true, readClientIds: [] }])
  })

  it('hints config and credential commits without inventing change rows', async () => {
    const before = head()
    hints.length = 0

    const config = ledger.getConfig()
    const stored = ledger.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-read',
      secret: 'glpat-fake',
      expectedRevision: config.configRevision
    })
    expect(stored.ok).toBe(true)
    await settle()

    expect(hints).toEqual([{ changes: false, readClientIds: [] }])
    expect(head()).toBe(before)
  })

  it('hints a read mark for that reader only, without advancing activity or the change feed', async () => {
    const { itemId } = ingest()
    await settle()
    hints.length = 0
    const before = head()
    const activity = ledger.listItems({ ...SCOPE, clientId: 'reader-1' }).rows[0]

    expect(ledger.markRead(SCOPE, { clientId: 'reader-1', itemId })).toBe(true)
    await settle()

    expect(hints).toEqual([{ changes: false, readClientIds: ['reader-1'] }])
    expect(head()).toBe(before)
    expect(ledger.listItems({ ...SCOPE, clientId: 'reader-2' }).rows[0].activitySeq).toBe(
      activity.activitySeq
    )
  })

  it('hints a read mark once, stays silent on a repeat, and hints again after new activity', async () => {
    const { itemId } = ingest()
    await settle()
    hints.length = 0

    expect(ledger.markRead(SCOPE, { clientId: 'reader-1', itemId })).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: false, readClientIds: ['reader-1'] }])

    hints.length = 0
    expect(ledger.markRead(SCOPE, { clientId: 'reader-1', itemId })).toBe(true)
    expect(ledger.markRead(SCOPE, { clientId: 'reader-1', itemId: itemId + 999 })).toBe(false)
    await settle()
    expect(hints).toEqual([])

    ingest({ dedupeKey: 'delivery-2', versionToken: 'v2', sourceOrder: 2 })
    await settle()
    hints.length = 0
    expect(ledger.markRead(SCOPE, { clientId: 'reader-1', itemId })).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: false, readClientIds: ['reader-1'] }])
  })

  it('never delivers a commit made before a listener subscribed, even within one turn', async () => {
    const { itemId } = ingest()
    await settle()
    hints.length = 0
    const early: Hint[] = []
    const late: Hint[] = []
    ledger.onCommitted((hint) => early.push(hint))

    ingest({ dedupeKey: 'delivery-2', versionToken: 'v2', sourceOrder: 2 })
    ledger.onCommitted((hint) => late.push(hint))
    ledger.markRead(SCOPE, { clientId: 'reader-1', itemId })
    await settle()

    expect(early).toEqual([{ changes: true, readClientIds: ['reader-1'] }])
    expect(late).toEqual([{ changes: false, readClientIds: ['reader-1'] }])
  })
})
