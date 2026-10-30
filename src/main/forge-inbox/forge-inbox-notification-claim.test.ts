import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import {
  createDispatchConfirmation,
  finishDispatchConfirmation
} from './forge-inbox-dispatch-confirmation'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { isForgeNotificationCurrent } from './forge-inbox-notification-candidates'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-action-dispatch'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const PROJECT = { projectId: PROJECT_ID, repoId: 'repo-1', enabled: true }
const NOTIFICATION_CURSOR_ROW = 'SELECT client_id FROM client_cursors ORDER BY client_id'

describe('forge inbox notification claim', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let order: number

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [PROJECT] })]))
    order = 0
  })
  afterEach(() => harness.dispose())

  function reopen(): void {
    ledger.close()
    ledger = harness.open()
  }

  function ingest(
    iid: number,
    options: {
      token?: string
      category?: string
      passive?: boolean
      pipeline?: unknown
      queueRun?: boolean
      runReason?: string
      kind?: 'merge_request' | 'issue'
    } = {}
  ) {
    order += 1
    const result = ledger.ingestEvent({
      hostId: ledger.hostId,
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: options.kind ?? 'merge_request',
      iid,
      dedupeKey: `webhook:msg-${order}`,
      eventKind: 'gitlab.merge_request',
      payload: {
        ...(options.passive && !options.category
          ? {}
          : { category: options.category ?? 'review-request' }),
        passive: options.passive ?? false,
        completeness: { complete: true },
        ...(options.pipeline ? { pipeline: options.pipeline } : {})
      },
      versionToken: options.token ?? `sha-${iid}-1`,
      sourceOrder: order,
      title: 'Add thing',
      itemState: 'opened',
      ...(options.queueRun ? { queueRun: { reason: options.runReason ?? 'review-request' } } : {})
    })
    if (result.duplicate) {
      throw new Error('fixture event was a duplicate')
    }
    return result
  }

  function runningRun(itemId: number) {
    const run = ledger.claimNextQueuedRun(SCOPE)
    if (!run || run.itemId !== itemId) {
      throw new Error('expected the item run to be claimable')
    }
    return run
  }

  const rows = (sql: string) => {
    const connection = new Database(harness.dbPath)
    try {
      return connection.prepare(sql).all()
    } finally {
      connection.close()
    }
  }

  it('claims a relevant active event once, and neither a second claim nor a reopen repeats it', () => {
    const { itemId, eventId } = ingest(7)

    const first = ledger.notifications.claim()
    expect(first.notifications).toEqual([
      expect.objectContaining({
        ownerId: ledger.hostId,
        instanceId: INSTANCE_ID,
        itemId,
        reason: 'review-request',
        eventId
      })
    ])
    expect(ledger.notifications.claim().notifications).toEqual([])
    reopen()
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('loses the notification when the process dies after the claim commits, and never retries it', () => {
    ingest(7)
    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    // The claim returned to a caller that died before publishing; nothing re-offers it.
    reopen()
    expect(ledger.notifications.claim()).toMatchObject({ notifications: [], hasMore: false })
    expect(ledger.listItems({ clientId: 'reader', ...SCOPE }).rows).toHaveLength(1)
  })

  it('writes no cursor row when the feed is empty', () => {
    expect(ledger.notifications.claim().notifications).toEqual([])
    expect(rows(NOTIFICATION_CURSOR_ROW)).toEqual([])
  })

  it('advances past passive events and recovered CI without alerting, then alerts on failed CI', () => {
    ingest(7, {
      passive: true,
      pipeline: { observed: { id: 9, status: 'success', sha: 'sha-7-1' } }
    })
    const passive = ledger.notifications.claim()
    expect(passive.notifications).toEqual([])
    expect(passive.scannedThroughSeq).toBe(ledger.readChangeHead(SCOPE))

    const failed = ingest(8, {
      category: 'pipeline-failure',
      pipeline: { observed: { id: 10, status: 'failed', sha: 'sha-8-1' } }
    })
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'pipeline-failure', eventId: failed.eventId })
    ])
  })

  it('ignores an event marked passive even when it carries a category', () => {
    ingest(7, { passive: true, category: 'review-request' })
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('does not revive an old failure that a newer passive recovery already replaced', () => {
    ingest(7, {
      token: 'ctx-1',
      category: 'pipeline-failure',
      pipeline: { observed: { id: 9, status: 'failed' } }
    })
    ingest(7, {
      token: 'ctx-2',
      passive: true,
      pipeline: { observed: { id: 10, status: 'success' } }
    })

    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('alerts only for the latest active context, even when an older one is on an earlier page', () => {
    ingest(7, { token: 'ctx-1' })
    const latest = ingest(7, { token: 'ctx-2' })

    const first = ledger.notifications.claim({ limit: 1 })
    const second = ledger.notifications.claim({ limit: 1 })

    expect([...first.notifications, ...second.notifications]).toEqual([
      expect.objectContaining({ eventId: latest.eventId })
    ])
  })

  it('reports a claimed event notice as no longer current once a newer context replaced it', () => {
    ingest(7, { token: 'ctx-1' })
    const [claimed] = ledger.notifications.claim().notifications
    expect(ledger.notifications.isCurrent(claimed)).toBe(true)

    ingest(7, { token: 'ctx-2', passive: true })

    expect(ledger.notifications.isCurrent(claimed)).toBe(false)
  })

  it('treats queued, running and superseded runs, reads, and cursor writes as churn', () => {
    const { itemId } = ingest(7, { passive: true, queueRun: true })
    ingest(7, { passive: true, queueRun: true, token: 'sha-7-2' })
    runningRun(itemId)
    ledger.markRead(SCOPE, { clientId: 'reader', itemId })
    ledger.setClientCursor({ ...SCOPE, clientId: 'reader', lastSeq: 1 })

    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('does not alert twice for the same item, category and context under a new message id', () => {
    ingest(7, { token: 'sha-7-1' })
    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    reopen()

    ingest(7, { token: 'sha-7-1' })
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('finds the earlier duplicate even when more than a page of newer history sits between', () => {
    ingest(7, { token: 'sha-7-1' })
    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    for (let i = 0; i < 130; i += 1) {
      ingest(7, { passive: true, token: 'sha-7-1' })
    }
    let drained = ledger.notifications.claim({ limit: 100 })
    while (drained.hasMore) {
      drained = ledger.notifications.claim({ limit: 100 })
    }

    ingest(7, { token: 'sha-7-1' })
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('requires a dispatch verdict even without confirmation metadata, but still announces ordinary success', () => {
    const ordinary = ingest(10, { passive: true, queueRun: true })
    const ordinaryRun = runningRun(ordinary.itemId)
    ledger.transitionRun(ordinaryRun.id, { to: 'succeeded' })
    const dispatched = ingest(11, {
      passive: true,
      queueRun: true,
      runReason: PROJECT_EVENT_DISPATCH_RUN_REASON
    })
    const dispatchRun = runningRun(dispatched.itemId)
    ledger.transitionRun(dispatchRun.id, { to: 'succeeded' })

    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'run-succeeded', runId: ordinaryRun.id })
    ])
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('holds the success alert of a dispatch run back while its effects are unconfirmed', () => {
    const dispatched = ingest(11, {
      passive: true,
      queueRun: true,
      runReason: PROJECT_EVENT_DISPATCH_RUN_REASON
    })
    const run = runningRun(dispatched.itemId)
    createDispatchConfirmation(ledger.ledgerContext(), {
      runId: run.id,
      bindingId: 'binding-1',
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 42,
      itemKind: 'merge_request',
      itemIid: 11,
      expectedSha: null
    })
    ledger.transitionRun(run.id, { to: 'succeeded' })

    expect(ledger.notifications.claim().notifications).toEqual([])

    const failing = ingest(12, {
      passive: true,
      queueRun: true,
      runReason: PROJECT_EVENT_DISPATCH_RUN_REASON
    })
    const failedRun = runningRun(failing.itemId)
    createDispatchConfirmation(ledger.ledgerContext(), {
      runId: failedRun.id,
      bindingId: 'binding-1',
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 42,
      itemKind: 'merge_request',
      itemIid: 12,
      expectedSha: null
    })
    ledger.transitionRun(failedRun.id, { to: 'failed', error: 'agent-failure' })

    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'run-failed', runId: failedRun.id })
    ])
  })

  function dispatchRun(iid: number) {
    const dispatched = ingest(iid, {
      passive: true,
      queueRun: true,
      runReason: PROJECT_EVENT_DISPATCH_RUN_REASON
    })
    const run = runningRun(dispatched.itemId)
    createDispatchConfirmation(ledger.ledgerContext(), {
      runId: run.id,
      bindingId: 'binding-1',
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 42,
      itemKind: 'merge_request',
      itemIid: iid,
      expectedSha: null
    })
    return { runId: run.id, itemId: dispatched.itemId }
  }

  function conclude(
    run: { runId: number; itemId: number },
    state: 'confirmed' | 'contradicted' | 'unconfirmable' | 'no-claim'
  ): void {
    finishDispatchConfirmation(ledger.ledgerContext(), run, { state, evidenceJson: '{}' })
  }

  it.each(['contradicted', 'unconfirmable'] as const)(
    'raises the existing project-event attention, not a success, when a dispatch ends %s',
    (state) => {
      const run = dispatchRun(21)
      ledger.transitionRun(run.runId, { to: 'succeeded' })
      conclude(run, state)

      const claimed = ledger.notifications.claim().notifications

      expect(claimed).toEqual([
        expect.objectContaining({
          reason: 'project-event',
          runId: run.runId,
          itemId: run.itemId
        })
      ])
      expect(ledger.notifications.claim().notifications).toEqual([])
    }
  )

  it('raises one attention when the success and the verdict are claimed apart', () => {
    const run = dispatchRun(22)
    ledger.transitionRun(run.runId, { to: 'succeeded' })
    expect(ledger.notifications.claim().notifications).toEqual([])

    conclude(run, 'contradicted')

    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'project-event', runId: run.runId })
    ])
  })

  it.each(['confirmed', 'no-claim'] as const)(
    'announces a dispatch that ends %s once, whichever change is claimed first',
    (state) => {
      const early = dispatchRun(23)
      ledger.transitionRun(early.runId, { to: 'succeeded' })
      conclude(early, state)
      expect(ledger.notifications.claim().notifications).toEqual([
        expect.objectContaining({ reason: 'run-succeeded', runId: early.runId })
      ])

      const late = dispatchRun(24)
      ledger.transitionRun(late.runId, { to: 'succeeded' })
      expect(ledger.notifications.claim().notifications).toEqual([])
      conclude(late, state)
      expect(ledger.notifications.claim().notifications).toEqual([
        expect.objectContaining({ reason: 'run-succeeded', runId: late.runId })
      ])
    }
  )

  it('keeps a failed run a failure and never turns its confirmation into a success', () => {
    const run = dispatchRun(25)
    ledger.transitionRun(run.runId, { to: 'failed', error: 'agent-failure' })
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'run-failed', runId: run.runId })
    ])

    conclude(run, 'confirmed')

    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('stays current for a claimed attention and stops once the policy moved', () => {
    const run = dispatchRun(26)
    ledger.transitionRun(run.runId, { to: 'succeeded' })
    conclude(run, 'unconfirmable')
    const [attention] = ledger.notifications.claim().notifications
    if (!attention) {
      throw new Error('expected the attention')
    }
    expect(attention.reason).toBe('project-event')
    expect(isForgeNotificationCurrent(ledger.ledgerContext(), attention)).toBe(true)

    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })

    expect(isForgeNotificationCurrent(ledger.ledgerContext(), attention)).toBe(false)
  })

  it('stays current for a claimed success of a confirmed dispatch', () => {
    const run = dispatchRun(27)
    ledger.transitionRun(run.runId, { to: 'succeeded' })
    conclude(run, 'confirmed')
    const [success] = ledger.notifications.claim().notifications

    expect(success).toMatchObject({ reason: 'run-succeeded' })
    expect(success && isForgeNotificationCurrent(ledger.ledgerContext(), success)).toBe(true)
  })

  it('alerts again for a new context on the same commit, across claims and a reopen, or a different category', () => {
    ingest(7, { token: 'sha-7-1' })
    ledger.notifications.claim()
    reopen()

    const newer = ingest(7, { token: 'sha-7-1+note-1' })
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ eventId: newer.eventId, reason: 'review-request' })
    ])
    const other = ingest(7, { token: 'sha-7-1+note-1', category: 'participating-update' })
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ eventId: other.eventId, reason: 'participating-update' })
    ])
  })

  it('alerts for current-policy succeeded and failed runs and ignores old-revision or old-policy ones', () => {
    const current = ingest(7, { passive: true, queueRun: true })
    const done = runningRun(current.itemId)
    ledger.notifications.claim()
    ledger.transitionRun(done.id, { to: 'succeeded' })
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'run-succeeded', runId: done.id })
    ])

    const failing = ingest(8, { passive: true, queueRun: true })
    const failedRun = runningRun(failing.itemId)
    ledger.transitionRun(failedRun.id, { to: 'failed', error: 'boom' })
    const failedClaim = ledger.notifications.claim().notifications
    expect(failedClaim).toEqual([
      expect.objectContaining({ reason: 'run-failed', runId: failedRun.id })
    ])
    expect(JSON.stringify(failedClaim)).not.toContain('boom')

    const stale = ingest(9, { passive: true, queueRun: true })
    const staleRun = runningRun(stale.itemId)
    ingest(9, { passive: true, token: 'sha-9-2' })
    ledger.transitionRun(staleRun.id, { to: 'succeeded' })
    expect(ledger.notifications.claim().notifications).toEqual([])

    const policy = ingest(10, { passive: true, queueRun: true })
    const policyRun = runningRun(policy.itemId)
    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
    ledger.transitionRun(policyRun.id, { to: 'failed' })
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('alerts for a pending current proposal only, not stale, rejected or consumed ones', () => {
    const open = ingest(7, { passive: true, queueRun: true })
    const run = runningRun(open.itemId)
    const created = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: { action: 'comment' }
    })
    if (!created.ok) {
      throw new Error('proposal fixture rejected')
    }
    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ reason: 'proposal-pending', proposalId: created.proposal.id })
    ])

    const rejectedRun = ingest(8, { passive: true, queueRun: true })
    const second = runningRun(rejectedRun.itemId)
    const rejected = ledger.createProposal({
      runId: second.id,
      expectedGeneration: second.generation,
      body: {}
    })
    if (!rejected.ok) {
      throw new Error('proposal fixture rejected')
    }
    ledger.rejectProposal(rejected.proposal.id)
    const outdated = ingest(9, { passive: true, queueRun: true })
    const third = runningRun(outdated.itemId)
    const staled = ledger.createProposal({
      runId: third.id,
      expectedGeneration: third.generation,
      body: {}
    })
    if (!staled.ok) {
      throw new Error('proposal fixture rejected')
    }
    ingest(9, { passive: true, token: 'sha-9-2' })
    expect(ledger.getProposal(staled.proposal.id)?.status).toBe('stale')
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('collapses one item to its pending proposal rather than the earlier event and run noise', () => {
    const { itemId } = ingest(7, { queueRun: true })
    const run = runningRun(itemId)
    const created = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: {}
    })
    if (!created.ok) {
      throw new Error('proposal fixture rejected')
    }

    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ itemId, reason: 'proposal-pending' })
    ])
  })

  it('keeps a pending proposal over a newer event on the same item and context', () => {
    const { itemId } = ingest(7, { queueRun: true })
    const run = runningRun(itemId)
    const created = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: {}
    })
    if (!created.ok) {
      throw new Error('proposal fixture rejected')
    }
    ingest(7, { category: 'participating-update' })

    expect(ledger.notifications.claim().notifications).toEqual([
      expect.objectContaining({ itemId, reason: 'proposal-pending' })
    ])
  })

  it('collapses repeated meaningful events on one item to the latest in the batch', () => {
    ingest(7, { token: 'sha-7-1' })
    const latest = ingest(7, { token: 'sha-7-2' })
    ingest(8, { token: 'sha-8-1' })

    const claim = ledger.notifications.claim()
    expect(claim.notifications.map((n) => [n.itemId, n.eventId])).toEqual([
      [latest.itemId, latest.eventId],
      [expect.any(Number), expect.any(Number)]
    ])
  })

  it('claims disjoint bounded pages that cover the feed exactly once', () => {
    const itemIds = Array.from({ length: 7 }, (_, i) => ingest(100 + i).itemId)

    const seen: number[] = []
    const pages: boolean[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claim = ledger.notifications.claim({ limit: 3 })
      expect(claim.notifications.length).toBeLessThanOrEqual(3)
      seen.push(...claim.notifications.map((n) => n.itemId))
      pages.push(claim.hasMore)
      if (!claim.hasMore) {
        break
      }
    }

    expect(pages).toEqual([true, true, false])
    expect(seen).toEqual(itemIds)
  })

  it('does not alert for a project disabled or removed since the event', () => {
    ingest(7)
    const revision = ledger.getConfig().configRevision
    ledger.updateConfig(
      revision,
      webhookConfig([webhookInstance({ projects: [{ ...PROJECT, enabled: false }] })])
    )

    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('keeps the internal cursor apart from every reader id the host stamps on RPC callers', () => {
    const readers = [
      rpcCallerOperationKey({ kind: 'local-cli' }),
      rpcCallerOperationKey({ kind: 'desktop' }),
      rpcCallerOperationKey({ kind: 'paired-device', deviceId: 'device-1' })
    ]
    ingest(7)
    for (const clientId of readers) {
      ledger.setClientCursor({ ...SCOPE, clientId, lastSeq: 1_000_000 })
      ledger.setClientCursor({ clientId, lastSeq: 1_000_000 })
    }

    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    const stored = rows(NOTIFICATION_CURSOR_ROW).map((row) => String(row.client_id))
    expect(stored.filter((id) => !readers.includes(id))).toHaveLength(1)
  })

  it('rolls the cursor back with a failed commit, offers nothing, and delivers once after recovery', () => {
    ingest(7)
    const fault = new Database(harness.dbPath)
    fault.exec(
      "CREATE TRIGGER notification_fault BEFORE INSERT ON client_cursors BEGIN SELECT RAISE(ABORT, 'fault'); END"
    )
    try {
      expect(() => ledger.notifications.claim()).toThrow()
      expect(rows(NOTIFICATION_CURSOR_ROW)).toEqual([])
    } finally {
      fault.exec('DROP TRIGGER notification_fault')
      fault.close()
    }

    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    expect(ledger.notifications.claim().notifications).toEqual([])
  })

  it('survives a malformed stored payload without stranding the cursor', () => {
    ingest(7, { token: 'ctx-1' })
    const corrupt = new Database(harness.dbPath)
    corrupt.exec("UPDATE events SET payload_json = '{not json'")
    corrupt.close()
    ingest(8)

    expect(ledger.notifications.claim().notifications).toHaveLength(1)
    expect(ledger.notifications.claim()).toMatchObject({ notifications: [], hasMore: false })
  })
})
