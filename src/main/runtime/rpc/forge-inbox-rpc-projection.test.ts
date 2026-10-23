import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANARY,
  configure,
  createForgeRpcHarness,
  recordOf,
  recordsOf,
  seedItem,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc projection', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  it('projects only whitelisted event summaries and never raw payload data', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const { itemId } = seedItem(ledger, ownerHostId, 1, {
      category: 'review-request',
      completeness: { complete: false, notes: true, diffs: false, extra: CANARY },
      body: `raw body ${CANARY}`,
      headers: { authorization: `Bearer ${CANARY}` }
    })
    const page = await harness.ok('forgeInbox.listEvents', { ownerHostId, itemId })
    const [event] = recordsOf(page.rows)
    expect(event).toMatchObject({
      eventKind: 'merge_request.updated',
      summary: {
        category: 'review-request',
        completeness: { complete: false, notes: true, diffs: false }
      }
    })
    expect(JSON.stringify(page)).not.toContain(CANARY)
  })

  it.each([
    ['null payload', null],
    ['a string payload', `oops ${CANARY}`],
    ['unknown category', { category: `<script>${CANARY}`, completeness: 'yes' }]
  ])('degrades to an empty summary for %s', async (_label, payload) => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const { itemId } = seedItem(harness.openLedger(ownerHostId), ownerHostId, 1, payload)
    const page = await harness.ok('forgeInbox.listEvents', { ownerHostId, itemId })
    expect(JSON.stringify(page)).not.toContain(CANARY)
    expect(recordsOf(page.rows)).toHaveLength(1)
  })

  it('omits proposal raw bodies, run error text and receipt internals from item detail', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const first = seedItem(ledger, ownerHostId, 1)
    const claimed = ledger.claimNextQueuedRun({ instanceId: 'gitlab-main' })
    if (!claimed || first.runId === null) {
      throw new Error('no run claimed')
    }
    const made = ledger.createProposal({
      runId: claimed.id,
      expectedGeneration: claimed.generation,
      body: { comment: `rawBody ${CANARY}`, authorization: `Bearer ${CANARY}` }
    })
    expect(made.ok).toBe(true)
    const second = seedItem(ledger, ownerHostId, 2)
    const failing = ledger.claimNextQueuedRun({ instanceId: 'gitlab-main' })
    if (!failing || second.runId === null) {
      throw new Error('no second run claimed')
    }
    ledger.transitionRun(failing.id, { to: 'failed', error: `ECONNRESET token=${CANARY}` })

    for (const itemId of [first.itemId, second.itemId]) {
      const detail = await harness.ok('forgeInbox.getItemDetail', { ownerHostId, itemId })
      expect(JSON.stringify(detail)).not.toContain(CANARY)
    }
    const runs = await harness.ok('forgeInbox.listRuns', { ownerHostId, itemId: second.itemId })
    expect(JSON.stringify(runs)).not.toContain(CANARY)
    expect(runs.rows).toEqual([expect.objectContaining({ state: 'failed' })])
    const changes = await harness.ok('forgeInbox.getChanges', { ownerHostId, afterSeq: 0 })
    expect(JSON.stringify(changes)).not.toContain(CANARY)

    const detail = await harness.ok('forgeInbox.getItemDetail', {
      ownerHostId,
      itemId: first.itemId
    })
    const proposals = recordsOf(recordOf(detail.detail).proposals)
    expect(proposals).toEqual([expect.objectContaining({ status: 'pending' })])
    expect(proposals[0]).not.toHaveProperty('body')
  })

  it('pages items newest first by cursor and reads changes without moving any cursor', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    for (const iid of [1, 2, 3]) {
      seedItem(ledger, ownerHostId, iid)
    }
    const first = await harness.ok('forgeInbox.listItems', { ownerHostId, limit: 2 })
    expect(recordsOf(first.rows).map((r) => r.iid)).toEqual([3, 2])
    const second = await harness.ok('forgeInbox.listItems', {
      ownerHostId,
      limit: 2,
      cursor: first.nextCursor
    })
    expect(recordsOf(second.rows).map((r) => r.iid)).toEqual([1])
    expect(second.nextCursor).toBeNull()

    const a = await harness.ok('forgeInbox.getChanges', { ownerHostId, afterSeq: 0, limit: 2 })
    const b = await harness.ok('forgeInbox.getChanges', { ownerHostId, afterSeq: 0, limit: 2 })
    expect(b).toEqual(a)
    expect(a.hasMore).toBe(true)
  })

  it('shows only known producer reasons and error codes, even when a secret is code-shaped', async () => {
    const SECRET = 'glpat-lowercase-secret'
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const known = seedItem(ledger, ownerHostId, 1)
    const hostile = seedItem(ledger, ownerHostId, 2, undefined, SECRET)
    const claimed = [1, 2].map(() => ledger.claimNextQueuedRun({ instanceId: 'gitlab-main' }))
    for (const run of claimed) {
      if (!run) {
        throw new Error('runs not claimed')
      }
      const error = run.itemId === hostile.itemId ? SECRET : 'worker-error'
      ledger.transitionRun(run.id, { to: 'failed', error })
    }

    const runs = await harness.ok('forgeInbox.listRuns', { ownerHostId })
    expect(JSON.stringify(runs)).not.toContain(SECRET)
    const byItem = new Map(recordsOf(runs.rows).map((run) => [run.itemId, run]))
    expect(byItem.get(known.itemId)).toMatchObject({
      reason: 'review-request',
      errorCode: 'worker-error'
    })
    expect(byItem.get(hostile.itemId)).toMatchObject({ reason: null, errorCode: 'unknown' })
    for (const itemId of [known.itemId, hostile.itemId]) {
      const detail = await harness.ok('forgeInbox.getItemDetail', { ownerHostId, itemId })
      expect(JSON.stringify(detail)).not.toContain(SECRET)
    }
  })

  it('passes every coordinator outcome code through to clients unchanged', async () => {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const codes = [
      'analysis-failed',
      'output-budget',
      'policy-revoked',
      'owner-stopped',
      'unknown-outcome'
    ]
    codes.forEach((_code, index) => seedItem(ledger, ownerHostId, index + 1))
    for (const code of codes) {
      const run = ledger.claimNextQueuedRun({ instanceId: 'gitlab-main' })
      if (!run) {
        throw new Error('runs not claimed')
      }
      ledger.transitionRun(run.id, { to: 'failed', error: code })
    }

    const runs = await harness.ok('forgeInbox.listRuns', { ownerHostId })
    const seen = recordsOf(runs.rows).map((run) => run.errorCode)
    expect(seen.sort()).toEqual([...codes].sort())
  })
})
