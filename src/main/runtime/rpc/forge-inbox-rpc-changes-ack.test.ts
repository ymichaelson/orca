import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import {
  changeSeqs,
  createStreamHarness,
  durableSeqs,
  openWebhookIngress,
  readyOf,
  seedUntilHead,
  settle
} from './forge-inbox-rpc-change-stream-test-kit'
import { FORGE_CHANGE_STREAM_WINDOW } from './forge-inbox-change-stream-limits'
import { configure, errorCodeOf, seedItem, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc changes ack and window', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  async function subscribed(ownerHostId: string, connectionId: string, params = {}) {
    const stream = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId, ...params },
      { caller: 'paired-a', connectionId }
    )
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')
    return { stream, subscriptionId: String(readyOf(stream).subscriptionId) }
  }

  const ack = (ownerHostId: string, subscriptionId: string, seq: number, connectionId: string) =>
    harness.call(
      'forgeInbox.ackChanges',
      { ownerHostId, subscriptionId, seq },
      'paired-a',
      connectionId
    )

  it('pauses at the window, resumes from the sent point on ack, and sees a mid-pause commit once', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedUntilHead(harness.openLedger(ownerHostId), ownerHostId, FORGE_CHANGE_STREAM_WINDOW + 150)
    const { stream, subscriptionId } = await subscribed(ownerHostId, 'c-1', { afterSeq: 0 })

    await stream.waitFor((frame) => frame.type === 'ready' && frame.latestSeq !== 0, 'paused ready')
    await settle()
    expect(changeSeqs(stream)).toHaveLength(FORGE_CHANGE_STREAM_WINDOW)

    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    await settle()
    expect(changeSeqs(stream)).toHaveLength(FORGE_CHANGE_STREAM_WINDOW)

    const durable = await durableSeqs(harness, ownerHostId)
    const sent = changeSeqs(stream)
    const beyondSent = await ack(ownerHostId, subscriptionId, durable.at(-1)!, 'c-1')
    expect(beyondSent.ok).toBe(false)
    const acked = await ack(ownerHostId, subscriptionId, sent.at(-1)!, 'c-1')
    expect(acked.ok).toBe(true)
    await stream.waitFor((frame) => frame.seq === durable.at(-1), 'rest of backlog')
    await settle()
    expect(changeSeqs(stream)).toEqual(durable)
  })

  it('delivers a live commit after catch-up from the same cursor without a gap or duplicate', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const { stream } = await subscribed(ownerHostId, 'c-1')
    const before = changeSeqs(stream)

    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    const durable = await durableSeqs(harness, ownerHostId)
    await stream.waitFor((frame) => frame.seq === durable.at(-1), 'live change')
    await settle()

    expect(before.length).toBeGreaterThan(0)
    expect(changeSeqs(stream)).toEqual(durable)
  })

  it('binds ack to its own subscription and connection and to sent seqs', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const { stream, subscriptionId } = await subscribed(ownerHostId, 'c-1')
    const sent = changeSeqs(stream)

    for (const [label, response] of [
      ['foreign connection', await ack(ownerHostId, subscriptionId, sent[0]!, 'c-2')],
      ['over sent', await ack(ownerHostId, subscriptionId, sent.at(-1)! + 1, 'c-1')],
      ['negative', await ack(ownerHostId, subscriptionId, -1, 'c-1')],
      ['unknown id', await ack(ownerHostId, 'forge-inbox-changes-c-1-999', 1, 'c-1')]
    ] as const) {
      expect(response.ok, label).toBe(false)
    }
    expect(
      await harness.ok(
        'forgeInbox.ackChanges',
        {
          ownerHostId,
          subscriptionId,
          seq: sent.at(-1)
        },
        'paired-a',
        'c-1'
      )
    ).toEqual({ cursor: sent.at(-1) })
    expect(errorCodeOf(await ack(ownerHostId, subscriptionId, sent[0]!, 'c-1'))).toBeNull()
  })

  it('rejects an ack from another paired reader that reuses the connection id', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const { stream, subscriptionId } = await subscribed(ownerHostId, 'c-1')
    const seq = changeSeqs(stream)[0]!

    const other = await harness.call(
      'forgeInbox.ackChanges',
      { ownerHostId, subscriptionId, seq },
      'paired-b',
      'c-1'
    )

    expect(other.ok).toBe(false)
  })

  it('persists a cursor only through ack, per paired reader, across reconnect', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const durable = await durableSeqs(harness, ownerHostId)
    const first = await subscribed(ownerHostId, 'c-1')
    expect(changeSeqs(first.stream)).toEqual(durable)
    first.stream.abort()
    await first.stream.done

    const unacked = await subscribed(ownerHostId, 'c-2')
    expect(changeSeqs(unacked.stream)).toEqual(durable)
    await ack(ownerHostId, unacked.subscriptionId, durable[0]!, 'c-2')
    unacked.stream.abort()
    await unacked.stream.done

    const resumed = await subscribed(ownerHostId, 'c-3')
    expect(changeSeqs(resumed.stream)).toEqual(durable.slice(1))
    const other = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        caller: 'paired-b',
        connectionId: 'c-4'
      }
    )
    await other.waitFor((frame) => frame.type === 'ready', 'ready')
    expect(changeSeqs(other)).toEqual(durable)
  })

  it('ignores a foreign or late unsubscribe and only the owning connection retires its stream', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const old = await subscribed(ownerHostId, 'c-1')
    const replacement = await subscribed(ownerHostId, 'c-1')

    expect(
      await harness.ok(
        'forgeInbox.unsubscribeChanges',
        { subscriptionId: replacement.subscriptionId },
        'paired-a',
        'c-other'
      )
    ).toEqual({ unsubscribed: false })
    expect(
      await harness.ok(
        'forgeInbox.unsubscribeChanges',
        { subscriptionId: old.subscriptionId },
        'paired-a',
        'c-1'
      )
    ).toEqual({ unsubscribed: true })
    await old.stream.done

    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    await replacement.stream.waitFor((frame) => frame.type === 'change', 'replacement change')
    expect(changeSeqs(old.stream)).toEqual([])
  })
})
