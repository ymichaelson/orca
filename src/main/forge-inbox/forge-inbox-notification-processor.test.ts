import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeNotification } from './forge-inbox-notification-candidates'
import { createForgeNotificationProcessor } from './forge-inbox-notification-processor'
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

describe('forge inbox notification processor', () => {
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

  function ingest(iid: number, options: { queueRun?: boolean; passive?: boolean } = {}) {
    order += 1
    const result = ledger.ingestEvent({
      hostId: ledger.hostId,
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: 'merge_request',
      iid,
      dedupeKey: `webhook:msg-${order}`,
      eventKind: 'gitlab.merge_request',
      payload: options.passive ? { passive: true } : { category: 'review-request', passive: false },
      versionToken: `ctx-${iid}`,
      sourceOrder: order,
      ...(options.queueRun ? { queueRun: { reason: 'review-request' } } : {})
    })
    if (result.duplicate) {
      throw new Error('duplicate fixture event')
    }
    return result
  }

  function pendingProposal(iid: number): number {
    const { itemId } = ingest(iid, { passive: true, queueRun: true })
    const run = ledger.claimNextQueuedRun(SCOPE)
    if (!run || run.itemId !== itemId) {
      throw new Error('run fixture')
    }
    const created = ledger.createProposal({
      runId: run.id,
      expectedGeneration: run.generation,
      body: {}
    })
    if (!created.ok) {
      throw new Error('proposal fixture')
    }
    return created.proposal.id
  }

  it('drains more than one claim page and lets the event loop run between pages', async () => {
    for (let iid = 1; iid <= 120; iid += 1) {
      ingest(iid)
    }
    const seen: ForgeNotification[] = []
    const turnAtPublish: number[] = []
    let loopTurns = 0
    let spinning = true
    const spin = () => {
      loopTurns += 1
      if (spinning) {
        setImmediate(spin)
      }
    }
    setImmediate(spin)
    const processor = createForgeNotificationProcessor(ledger, [
      (n) => {
        seen.push(n)
        turnAtPublish.push(loopTurns)
      }
    ])

    processor.wake()
    await vi.waitFor(() => expect(seen).toHaveLength(120))
    spinning = false
    await processor.stop()

    expect(new Set(seen.map((n) => n.itemId)).size).toBe(120)
    expect(turnAtPublish.at(-1)).toBeGreaterThan(turnAtPublish[0])
  })

  it('coalesces wakes into one single-flight drain and publishes nothing twice', async () => {
    ingest(1)
    const seen: ForgeNotification[] = []
    const processor = createForgeNotificationProcessor(ledger, [(n) => seen.push(n)])

    processor.wake()
    processor.wake()
    processor.wake()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    processor.wake()
    await processor.stop()
    expect(seen).toHaveLength(1)
  })

  it('wakes on a committed change but not on a read or cursor commit', async () => {
    const seen: ForgeNotification[] = []
    const processor = createForgeNotificationProcessor(ledger, [(n) => seen.push(n)])

    const { itemId } = ingest(1)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    ledger.markRead(SCOPE, { clientId: 'reader', itemId })
    ledger.setClientCursor({ ...SCOPE, clientId: 'reader', lastSeq: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await processor.stop()

    expect(seen).toHaveLength(1)
  })

  it('does not publish a claimed approval that a sink earlier in the batch revoked', async () => {
    const first = pendingProposal(1)
    const second = pendingProposal(2)
    const seen: ForgeNotification[] = []
    const processor = createForgeNotificationProcessor(ledger, [
      (n) => {
        seen.push(n)
        ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
      }
    ])

    processor.wake()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await processor.stop()

    expect(seen.map((n) => n.proposalId)).toEqual([first])
    expect(ledger.getProposal(second)?.status).toBe('stale')
  })

  it('claims only for committed changes, never for a read or cursor commit', async () => {
    const { itemId } = ingest(1)
    const claims = vi.spyOn(ledger.notifications, 'claim')
    const processor = createForgeNotificationProcessor(ledger, [() => undefined])
    processor.wake()
    await vi.waitFor(() => expect(claims).toHaveBeenCalled())
    const before = claims.mock.calls.length

    ledger.markRead(SCOPE, { clientId: 'reader', itemId })
    ledger.setClientCursor({ ...SCOPE, clientId: 'reader', lastSeq: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await processor.stop()

    expect(claims.mock.calls.length).toBe(before)
  })

  it('stops a notification mid-fan-out so later sinks never see it', async () => {
    ingest(1)
    const later = vi.fn()
    const first = vi.fn(() => void processor.stop())
    const processor = createForgeNotificationProcessor(ledger, [first, later])
    processor.wake()
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    await processor.stop()

    expect(later).not.toHaveBeenCalled()
  })

  it('delivers a change committed by a sink during the final page without another wake', async () => {
    ingest(1)
    const seen: ForgeNotification[] = []
    const processor = createForgeNotificationProcessor(ledger, [
      (n) => {
        seen.push(n)
        if (seen.length === 1) {
          ingest(2)
        }
      }
    ])

    processor.wake()
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    await processor.stop()

    expect(new Set(seen.map((n) => n.itemId)).size).toBe(2)
  })

  it('does not hand a second sink an approval the first sink just revoked', async () => {
    const proposalId = pendingProposal(1)
    const first = vi.fn(() =>
      ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: PROJECT_ID })
    )
    const second = vi.fn()
    const processor = createForgeNotificationProcessor(ledger, [first, second])

    processor.wake()
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    await processor.stop()

    expect(first).toHaveBeenCalledWith(expect.objectContaining({ proposalId }))
    expect(second).not.toHaveBeenCalled()
  })

  it('publishes nothing after stop, even for changes already committed', async () => {
    const seen: ForgeNotification[] = []
    const processor = createForgeNotificationProcessor(ledger, [(n) => seen.push(n)])
    const stopped = processor.stop()
    ingest(1)
    processor.wake()
    await stopped
    await new Promise((resolve) => setImmediate(resolve))

    expect(seen).toEqual([])
  })
})
