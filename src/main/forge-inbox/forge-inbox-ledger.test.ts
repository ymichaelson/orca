import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ForgeInboxHostMismatchError, ForgeInboxSchemaError } from './forge-inbox-database'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { countUnreadForgeItems } from './forge-inbox-queries'
import type { ForgeEventIngest, ForgeProposal } from './forge-inbox-types'

const SCOPE = { instanceId: 'gitlab-main' }
const HOST = { hostId: 'host-a' }
const approval = (p: ForgeProposal) => ({
  revision: p.revision,
  policyGeneration: p.policyGeneration
})
const PROJECT = { instanceId: 'gitlab-main', projectId: 'group/repo' }

function event(overrides: Partial<ForgeEventIngest> = {}): ForgeEventIngest {
  const merged = {
    ...HOST,
    ...SCOPE,
    projectId: 'group/repo',
    kind: 'merge_request' as const,
    iid: 7,
    dedupeKey: 'delivery-1',
    eventKind: 'merge_request.updated',
    payload: { n: 1 },
    versionToken: 'v1',
    title: 'Add thing',
    itemState: 'opened',
    ...overrides
  }
  return { sourceOrder: Number(merged.versionToken.replace(/\D/g, '')), ...merged }
}

describe('forge inbox ledger', () => {
  let root: string
  let dbPath: string
  let clock: number
  let ledger: ForgeInboxLedger
  const open = () => ForgeInboxLedger.open(dbPath, { hostId: 'host-a', now: () => ++clock })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-inbox-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    ledger = open()
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  function ingest(overrides: Partial<ForgeEventIngest> = {}) {
    const result = ledger.ingestEvent(event(overrides))
    if (result.duplicate) {
      throw new Error('unexpected duplicate')
    }
    return result
  }

  function runningProposal(token = 'v1', key = `d-${token}`, sourceOrder?: number) {
    const { itemId, runId } = ingest({
      versionToken: token,
      dedupeKey: key,
      ...(sourceOrder === undefined ? {} : { sourceOrder }),
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
    return { itemId, runId: claimed.id, proposal: made.proposal }
  }

  it('keeps events, runs, receipts and seq across reopen', () => {
    const { proposal } = runningProposal()
    const consumed = ledger.consumeProposal(proposal.id, approval(proposal))
    expect(consumed.ok).toBe(true)
    const receipt = ledger.beginReceipt({ proposalId: proposal.id })
    expect(receipt.started).toBe(true)
    const before = ledger.listChanges(SCOPE, { afterSeq: 0 })
    ledger.close()

    ledger = open()
    const after = ledger.listChanges(SCOPE, { afterSeq: 0 })
    expect(after.changes.slice(0, before.changes.length)).toEqual(before.changes)
    // Receipts and the in-flight run both belong to a process that is gone.
    expect(after.changes.slice(before.changes.length).map((c) => c.change)).toEqual([
      'unknown',
      'unverifiable'
    ])
    expect(ledger.listRuns(SCOPE, {}).rows).toHaveLength(1)
    const again = ledger.beginReceipt({ proposalId: proposal.id })
    expect(again.started).toBe(false)
    expect(again.receipt?.state).toBe('unknown')
    ingest({ dedupeKey: 'later', versionToken: 'v2' })
    const last = ledger.listChanges(SCOPE, { afterSeq: before.nextSeq })
    expect(last.changes[0].seq).toBeGreaterThan(before.nextSeq)
  })

  it('counts a duplicate delivery once and leaves state untouched', () => {
    ingest()
    const changes = ledger.listChanges(SCOPE, { afterSeq: 0 }).changes.length
    const dup = ledger.ingestEvent(
      event({ payload: { n: 2 }, title: 'Changed', versionToken: 'v9' })
    )
    expect(dup.duplicate).toBe(true)
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toHaveLength(changes)
    const item = ledger.listItems({ ...SCOPE, clientId: 'c' }).rows[0]
    expect(item.title).toBe('Add thing')
    expect(item.currentRevision).toBe(1)
  })

  it('scopes reads by instance and refuses another host', () => {
    ingest()
    ingest({ instanceId: 'gitlab-other', dedupeKey: 'delivery-1' })
    expect(ledger.listItems({ instanceId: 'gitlab-main', clientId: 'c' }).rows).toHaveLength(1)
    expect(ledger.listItems({ clientId: 'c' }).rows).toHaveLength(2)
    expect(() => ledger.ingestEvent(event({ hostId: 'host-b' }))).toThrow(/host/)
    ledger.close()
    expect(() => ForgeInboxLedger.open(dbPath, { hostId: 'host-b' })).toThrow(
      ForgeInboxHostMismatchError
    )
    ledger = open()
  })

  it('keeps the head when a delayed older delivery arrives, regardless of SHA order', () => {
    ingest({ versionToken: 'v20', dedupeKey: 'new' })
    const late = ingest({ versionToken: 'aaa10', dedupeKey: 'late', sourceOrder: 10 })
    expect(late.newRevision).toBe(false)
    expect(late.revision).toBe(1)
    const item = ledger.listItems({ clientId: 'c' }).rows[0]
    expect(item.currentRevision).toBe(1)
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toHaveLength(2)
    const newer = ingest({ versionToken: 'zzz', dedupeKey: 'newer', sourceOrder: 30 })
    expect(newer.revision).toBe(2)
  })

  it('lets a proposal be approved after its analysis run succeeded', () => {
    const { runId, proposal } = runningProposal()
    expect(ledger.transitionRun(runId, { to: 'succeeded' }).ok).toBe(true)
    const ok = ledger.consumeProposal(proposal.id, approval(proposal))
    expect(ok.ok).toBe(true)
    expect(ledger.getRun(runId)?.state).toBe('succeeded')
  })

  it('coalesces queued runs to the latest revision while a running run keeps its old revision', () => {
    ingest({ queueRun: { reason: 'first' } })
    const running = ledger.claimNextQueuedRun(SCOPE)
    const second = ingest({ dedupeKey: 'd2', versionToken: 'v2', queueRun: { reason: 'second' } })
    const third = ingest({ dedupeKey: 'd3', versionToken: 'v3', queueRun: { reason: 'third' } })
    const runs = ledger.listRuns(SCOPE, {}).rows
    expect(runs.map((r) => [r.id, r.state, r.revision])).toEqual([
      [third.runId, 'queued', 3],
      [second.runId, 'superseded', 2],
      [running?.id, 'running', 1]
    ])
  })

  it('does not queue a run for passive events', () => {
    ingest()
    expect(ledger.listRuns(SCOPE, {}).rows).toEqual([])
  })

  it('rejects approval of a proposal made stale by a new revision', () => {
    const { itemId, proposal } = runningProposal()
    ingest({ dedupeKey: 'd2', versionToken: 'v2' })
    expect(ledger.getProposal(proposal.id)?.status).toBe('stale')
    const result = ledger.consumeProposal(proposal.id, approval(proposal))
    expect(result).toEqual({ ok: false, reason: 'not-pending' })
    expect(ledger.getItemDetail(SCOPE, itemId, 'c')?.proposals[0].status).toBe('stale')
  })

  it('stores a proposal from an outdated run as stale and keeps the run running', () => {
    ingest({ queueRun: { reason: 'x' } })
    const run = ledger.claimNextQueuedRun(SCOPE)
    ingest({ dedupeKey: 'd2', versionToken: 'v2' })
    const made = ledger.createProposal({
      runId: run!.id,
      expectedGeneration: run!.generation,
      body: {}
    })
    expect(made.ok && made.proposal.status).toBe('stale')
    expect(ledger.getRun(run!.id)?.state).toBe('running')
  })

  it('refuses a proposal from a running run whose policy generation was revoked', () => {
    const { itemId, runId } = ingest({ queueRun: { reason: 'x' } })
    const claimed = ledger.claimNextQueuedRun(SCOPE)!
    expect(claimed.id).toBe(runId)
    expect(ledger.bumpPolicyGeneration(PROJECT)).toBe(claimed.policyGeneration + 1)
    const before = ledger.listChanges(SCOPE, { afterSeq: 0 })

    const made = ledger.createProposal({
      runId: claimed.id,
      expectedGeneration: claimed.generation,
      body: {}
    })

    expect(made).toEqual({ ok: false, reason: 'policy-generation-mismatch' })
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 })).toEqual(before)
    expect(ledger.getItemDetail(SCOPE, itemId, 'c')?.proposals).toEqual([])
    expect(ledger.getRun(claimed.id)?.state).toBe('running')
  })

  it('binds a proposal to the policy generation the run was queued under', () => {
    ingest({ queueRun: { reason: 'x' } })
    const generation = ledger.bumpPolicyGeneration(PROJECT)
    ingest({ dedupeKey: 'd2', versionToken: 'v2', queueRun: { reason: 'x' } })
    const run = ledger.claimNextQueuedRun(SCOPE)!
    expect(run.policyGeneration).toBe(generation)

    const made = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: {}
    })

    if (!made.ok) {
      throw new Error(made.reason)
    }
    expect(made.proposal.policyGeneration).toBe(run.policyGeneration)
  })

  it('consumes an approval once and refuses a mismatched revision', () => {
    const { proposal } = runningProposal()
    const wrong = ledger.consumeProposal(proposal.id, {
      ...approval(proposal),
      revision: proposal.revision + 1
    })
    expect(wrong).toEqual({ ok: false, reason: 'stale' })
    const expected = approval(proposal)
    expect(ledger.consumeProposal(proposal.id, expected).ok).toBe(true)
    expect(ledger.consumeProposal(proposal.id, expected)).toEqual({
      ok: false,
      reason: 'not-pending'
    })
  })

  it('refuses illegal run transitions and stale generations', () => {
    ingest({ queueRun: { reason: 'x' } })
    const run = ledger.claimNextQueuedRun(SCOPE)!
    expect(ledger.transitionRun(run.id, { to: 'queued' })).toEqual({
      ok: false,
      reason: 'illegal-transition'
    })
    expect(ledger.transitionRun(run.id, { to: 'failed', expectedGeneration: 0 })).toEqual({
      ok: false,
      reason: 'generation-mismatch'
    })
    expect(ledger.transitionRun(run.id, { to: 'unverifiable', error: 'timeout' }).ok).toBe(true)
  })

  it('does not begin a receipt for an unconsumed proposal and never replays an existing key', () => {
    const { proposal } = runningProposal()
    expect(ledger.beginReceipt({ proposalId: proposal.id }).receipt).toBeNull()
    ledger.consumeProposal(proposal.id, approval(proposal))
    const first = ledger.beginReceipt({ proposalId: proposal.id })
    expect(first.started).toBe(true)
    expect(ledger.beginReceipt({ proposalId: proposal.id }).started).toBe(false)
    expect(
      ledger.finishReceipt(first.receipt!.id, { state: 'applied', result: { note: 1 } })?.state
    ).toBe('applied')
    expect(ledger.finishReceipt(first.receipt!.id, { state: 'failed' })).toBeNull()
  })

  it('tracks unread per client independent of run state and re-flags updates', () => {
    const { itemId } = ingest({ queueRun: { reason: 'x' } })
    expect(ledger.listItems({ ...SCOPE, clientId: 'phone', unreadOnly: true }).rows).toHaveLength(1)
    expect(countUnreadForgeItems(ledger.ledgerContext(), { ...SCOPE, clientId: 'phone' })).toBe(1)
    // A list row names what it needs without a second read: its handling and its newest run.
    expect(ledger.listItems({ ...SCOPE, clientId: 'phone' }).rows[0]).toMatchObject({
      handling: { state: 'processing' },
      latestRunState: 'queued'
    })
    expect(ledger.markRead(SCOPE, { clientId: 'phone', itemId })).toBe(true)
    expect(ledger.listItems({ ...SCOPE, clientId: 'phone', unreadOnly: true }).rows).toHaveLength(0)
    expect(countUnreadForgeItems(ledger.ledgerContext(), { ...SCOPE, clientId: 'phone' })).toBe(0)
    expect(ledger.listItems({ ...SCOPE, clientId: 'desktop', unreadOnly: true }).rows).toHaveLength(
      1
    )
    expect(countUnreadForgeItems(ledger.ledgerContext(), { ...SCOPE, clientId: 'desktop' })).toBe(1)
    expect(ledger.listRuns(SCOPE, { itemId }).rows[0].state).toBe('queued')
    ingest({ dedupeKey: 'd2', versionToken: 'v2' })
    expect(ledger.getItemDetail(SCOPE, itemId, 'phone')?.item.unread).toBe(true)
    // A new activity marks the item unread again, so a finished run raises the sidebar count.
    expect(countUnreadForgeItems(ledger.ledgerContext(), { ...SCOPE, clientId: 'phone' })).toBe(1)
    expect(ledger.markRead({ instanceId: 'other' }, { clientId: 'phone', itemId })).toBe(false)
  })

  it('pages items, runs and changes with a bounded size', () => {
    for (let i = 1; i <= 5; i++) {
      ingest({ iid: i, dedupeKey: `d${i}`, queueRun: { reason: 'x' } })
    }
    const first = ledger.listItems({ ...SCOPE, clientId: 'c', limit: 2 })
    expect(first.rows.map((r) => r.iid)).toEqual([5, 4])
    const second = ledger.listItems({
      ...SCOPE,
      clientId: 'c',
      limit: 2,
      cursor: first.nextCursor!
    })
    expect(second.rows.map((r) => r.iid)).toEqual([3, 2])
    const runs = ledger.listRuns(SCOPE, { limit: 3, states: ['queued'] })
    expect(runs.rows).toHaveLength(3)
    expect(runs.nextCursor).not.toBeNull()
    expect(ledger.listRuns(SCOPE, { limit: 100000 }).rows).toHaveLength(5)
    const changes = ledger.listChanges(SCOPE, { afterSeq: 0, limit: 4 })
    expect(changes.changes).toHaveLength(4)
    expect(changes.hasMore).toBe(true)
    expect(
      ledger.listChanges(SCOPE, { afterSeq: changes.nextSeq, limit: 100 }).changes[0].seq
    ).toBe(changes.nextSeq + 1)
  })

  it('stores client change cursors per scope without moving backwards', () => {
    const scope = { ...SCOPE, clientId: 'phone' }
    ledger.setClientCursor({ ...scope, lastSeq: 9 })
    ledger.setClientCursor({ ...scope, lastSeq: 4 })
    expect(ledger.getClientCursor(scope)).toBe(9)
    expect(ledger.getClientCursor({ instanceId: 'other', clientId: 'phone' })).toBe(0)
  })

  it('rolls back every record when an ingest fails midway', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => ledger.ingestEvent(event({ payload: circular }))).toThrow()
    expect(ledger.listItems({ ...SCOPE, clientId: 'c' }).rows).toEqual([])
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toEqual([])
    expect(ingest().newRevision).toBe(true)
  })

  it('revokes and rebinds proposals through the durable policy generation', () => {
    const { proposal } = runningProposal()
    expect(proposal.policyGeneration).toBe(0)
    expect(ledger.bumpPolicyGeneration(PROJECT)).toBe(1)
    expect(ledger.getProposal(proposal.id)?.status).toBe('stale')
    expect(ledger.consumeProposal(proposal.id, approval(proposal)).ok).toBe(false)
    ingest({ dedupeKey: 'd2', versionToken: 'v2', queueRun: { reason: 'x' } })
    const run = ledger.claimNextQueuedRun(SCOPE)!
    const made = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: {}
    })
    if (!made.ok) {
      throw new Error(made.reason)
    }
    expect(made.proposal.policyGeneration).toBe(1)
    expect(
      ledger.consumeProposal(made.proposal.id, { ...approval(made.proposal), policyGeneration: 0 })
        .ok
    ).toBe(false)
    expect(ledger.consumeProposal(made.proposal.id, approval(made.proposal)).ok).toBe(true)
  })

  it('allows one receipt per proposal and never a second write after an unknown outcome', () => {
    const { proposal } = runningProposal()
    ledger.consumeProposal(proposal.id, approval(proposal))
    const first = ledger.beginReceipt({ proposalId: proposal.id })
    expect(first.started).toBe(true)
    ledger.close()
    ledger = open()
    const second = ledger.beginReceipt({ proposalId: proposal.id })
    expect(second.started).toBe(false)
    expect(second.receipt?.id).toBe(first.receipt?.id)
    expect(second.receipt?.state).toBe('unknown')
  })

  it('records receipts and running work made unknown by a restart in the change feed', () => {
    const { proposal, runId } = runningProposal()
    ledger.consumeProposal(proposal.id, approval(proposal))
    ledger.beginReceipt({ proposalId: proposal.id })
    const seen = ledger.listChanges(SCOPE, { afterSeq: 0, limit: 100 }).nextSeq
    ledger.close()
    ledger = open()
    const after = ledger.listChanges(SCOPE, { afterSeq: seen })
    expect(after.changes.map((c) => [c.entity, c.change])).toEqual([
      ['receipt', 'unknown'],
      ['run', 'unverifiable']
    ])
    expect(ledger.getRun(runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
  })

  it('does not let a delayed older delivery overwrite item metadata', () => {
    ingest({ versionToken: 'v20', dedupeKey: 'new', title: 'Latest', itemState: 'merged' })
    ingest({
      versionToken: 'aaa10',
      dedupeKey: 'late',
      sourceOrder: 10,
      title: 'Old',
      itemState: 'opened'
    })
    const item = ledger.listItems({ clientId: 'c' }).rows[0]
    expect([item.title, item.state]).toEqual(['Latest', 'merged'])
  })

  it('keeps pages stable when items on later pages receive new activity', () => {
    for (let i = 1; i <= 5; i++) {
      ingest({ iid: i, dedupeKey: `d${i}` })
    }
    const first = ledger.listItems({ clientId: 'c', limit: 2 })
    ingest({ iid: 2, dedupeKey: 'bump', versionToken: 'v5' })
    ingest({ iid: 1, dedupeKey: 'bump1', versionToken: 'v6' })
    const second = ledger.listItems({ clientId: 'c', limit: 2, cursor: first.nextCursor! })
    const third = ledger.listItems({ clientId: 'c', limit: 2, cursor: second.nextCursor! })
    const iids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.iid)
    expect(iids).toEqual([5, 4, 3, 2, 1])
  })

  it.each([
    [
      'a missing table',
      (path: string) => {
        const raw = new Database(path)
        raw.exec('DROP TABLE receipts')
        raw.close()
      }
    ],
    [
      'damaged later pages',
      (path: string) => {
        const bytes = readFileSync(path)
        bytes.fill(0xff, 4096 * 2, 4096 * 2 + 2048)
        writeFileSync(path, bytes)
      }
    ]
  ])('refuses %s in an existing database without touching it', (_name, damage) => {
    ingest()
    ledger.close()
    damage(dbPath)
    const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    const before = digest()
    expect(() => open()).toThrow()
    expect(digest()).toBe(before)
    rmSync(dbPath, { force: true })
    ledger = open()
  })

  it('refuses a newer schema and a corrupt file without touching their bytes', () => {
    ledger.close()
    const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    const newer = new Database(dbPath)
    newer.pragma('user_version = 99')
    newer.close()
    let before = digest()
    expect(() => ForgeInboxLedger.open(dbPath, { hostId: 'host-a' })).toThrow(ForgeInboxSchemaError)
    expect(digest()).toBe(before)

    writeFileSync(dbPath, Buffer.from('not a sqlite database, just bytes'.repeat(40)))
    before = digest()
    expect(() => ForgeInboxLedger.open(dbPath, { hostId: 'host-a' })).toThrow()
    expect(digest()).toBe(before)
    rmSync(dbPath, { force: true })
    ledger = open()
  })

  it('keeps the original version and order on an event that did not move the head', () => {
    ingest({ versionToken: 'v20', dedupeKey: 'new' })
    ingest({ versionToken: 'aaa10', dedupeKey: 'late', sourceOrder: 10 })
    const events = ledger.listEvents(SCOPE, { itemId: 1 }).rows
    expect(events.map((e) => [e.versionToken, e.sourceOrder, e.revision])).toEqual([
      ['aaa10', 10, 1],
      ['v20', 20, 1]
    ])
  })

  it('keys a standalone pipeline by its own identity beside a merge request', () => {
    const pipeline = ingest({ kind: 'pipeline', iid: 7, dedupeKey: 'p1', versionToken: 'v1' })
    const mr = ingest({ dedupeKey: 'm1', versionToken: 'v1' })
    expect(pipeline.itemId).not.toBe(mr.itemId)
    expect(
      ledger
        .listItems({ clientId: 'c' })
        .rows.map((i) => i.kind)
        .sort()
    ).toEqual(['merge_request', 'pipeline'])
  })

  it('advances the order watermark on a known token so a delayed first-seen version cannot take the head', () => {
    ingest({ versionToken: 'A', sourceOrder: 100, dedupeKey: 'a1' })
    const refreshed = ingest({ versionToken: 'A', sourceOrder: 300, dedupeKey: 'a2' })
    expect(refreshed.newRevision).toBe(false)
    const late = ingest({ versionToken: 'B', sourceOrder: 200, dedupeKey: 'b1' })
    expect(late.newRevision).toBe(false)
    expect(late.revision).toBe(1)
    expect(ledger.listItems({ clientId: 'c' }).rows[0].currentRevision).toBe(1)
  })

  it('reverts to a previously seen token as a new revision and stales its approvals', () => {
    ingest({ versionToken: 'A', sourceOrder: 100, dedupeKey: 'a1' })
    const { proposal } = runningProposal('B', 'b1', 200)
    const back = ingest({ versionToken: 'A', sourceOrder: 400, dedupeKey: 'a2' })
    expect(back.newRevision).toBe(true)
    expect(back.revision).toBe(3)
    expect(ledger.getProposal(proposal.id)?.status).toBe('stale')
  })

  it('moves back to the first token when it returns with a newer order than the second', () => {
    ingest({ versionToken: 'A', sourceOrder: 100, dedupeKey: 'a1' })
    const { proposal } = runningProposal('B', 'b1', 200)
    const back = ingest({ versionToken: 'A', sourceOrder: 300, dedupeKey: 'a2' })
    expect([back.newRevision, back.revision]).toEqual([true, 3])
    expect(ledger.getProposal(proposal.id)?.status).toBe('stale')
  })

  it('rejects a non-finite source order before touching the ledger', () => {
    for (const sourceOrder of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ledger.ingestEvent(event({ sourceOrder }))).toThrow(/sourceOrder/)
    }
    expect(ledger.listItems({ clientId: 'c' }).rows).toHaveLength(0)
    expect(ledger.listChanges(SCOPE, { afterSeq: 0 }).changes).toHaveLength(0)
  })

  it('blocks a first receipt once the head or the policy generation moved after approval', () => {
    const a = runningProposal('v1', 'a')
    ledger.consumeProposal(a.proposal.id, approval(a.proposal))
    ingest({ versionToken: 'v2', dedupeKey: 'a2' })
    expect(ledger.beginReceipt({ proposalId: a.proposal.id })).toEqual({
      started: false,
      receipt: null
    })
    const b = runningProposal('v3', 'b')
    ledger.consumeProposal(b.proposal.id, approval(b.proposal))
    ledger.bumpPolicyGeneration(PROJECT)
    expect(ledger.beginReceipt({ proposalId: b.proposal.id })).toEqual({
      started: false,
      receipt: null
    })
  })

  it('still returns an existing receipt for reconciliation after revocation', () => {
    const { proposal } = runningProposal()
    ledger.consumeProposal(proposal.id, approval(proposal))
    const first = ledger.beginReceipt({ proposalId: proposal.id })
    ledger.bumpPolicyGeneration(PROJECT)
    ingest({ versionToken: 'v2', dedupeKey: 'd2' })
    const again = ledger.beginReceipt({ proposalId: proposal.id })
    expect(again.started).toBe(false)
    expect(again.receipt?.id).toBe(first.receipt?.id)
  })

  it('flags an item unread again for proposal, completion and receipt results', () => {
    const { itemId, runId, proposal } = runningProposal()
    const unread = () => ledger.getItemDetail(SCOPE, itemId, 'phone')?.item.unread
    const read = () => ledger.markRead(SCOPE, { clientId: 'phone', itemId })
    read()
    expect(unread()).toBe(false)
    expect(ledger.getRun(runId)?.state).toBe('running')
    ledger.transitionRun(runId, { to: 'succeeded' })
    expect(unread()).toBe(true)
    read()
    ledger.consumeProposal(proposal.id, approval(proposal))
    expect(unread()).toBe(true)
    read()
    const receipt = ledger.beginReceipt({ proposalId: proposal.id }).receipt!
    expect(unread()).toBe(true)
    read()
    ledger.finishReceipt(receipt.id, { state: 'applied' })
    expect(unread()).toBe(true)
  })

  it('keeps item activity at the newest change after an ingest queues a run', () => {
    const { itemId } = ingest({ queueRun: { reason: 'x' } })
    const last = ledger.listChanges(SCOPE, { afterSeq: 0 }).changes.at(-1)!
    expect(ledger.getItemDetail(SCOPE, itemId, 'c')?.item.activitySeq).toBe(last.seq)
  })

  it('refuses a populated unversioned SQLite file without touching its bytes', () => {
    ledger.close()
    rmSync(dbPath, { force: true })
    const foreign = new Database(dbPath)
    foreign.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    foreign.close()
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    expect(() => ForgeInboxLedger.open(dbPath, { hostId: 'host-a' })).toThrow(ForgeInboxSchemaError)
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(before)
    rmSync(dbPath, { force: true })
    ledger = open()
  })
})
