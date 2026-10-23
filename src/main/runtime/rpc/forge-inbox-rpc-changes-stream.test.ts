import './unused-default-rpc-methods.test-fixture'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeSeqs,
  createStreamHarness,
  durableSeqs,
  openWebhookIngress,
  readyOf,
  seedUntilHead,
  settle
} from './forge-inbox-rpc-change-stream-test-kit'
import { configure, seedItem, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc changes stream', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  it('refuses mobile and a mismatched owner on subscribe before registering anything', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)

    const mobile = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      { caller: 'mobile' }
    )
    const wrong = harness.stream('forgeInbox.subscribeChanges', { ownerHostId: `${ownerHostId}-x` })
    const unidentified = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        caller: 'unidentified'
      }
    )
    await Promise.all([mobile.done, wrong.done, unidentified.done])

    expect(mobile.errors).toEqual(['forbidden'])
    expect(wrong.errors).toEqual(['forge_inbox_owner_mismatch'])
    expect(unidentified.errors).toEqual(['forge_inbox_caller_unidentified'])
    expect([mobile, wrong, unidentified].flatMap((stream) => stream.frames)).toEqual([])
  })

  it('subscribes to a dormant owner without creating a file and still delivers the first-use changes', async () => {
    harness = await createStreamHarness()
    const ownerHostId = String((await harness.ok('forgeInbox.getConfig', {})).ownerHostId)

    const stream = harness.stream('forgeInbox.subscribeChanges', { ownerHostId })
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')
    expect(existsSync(harness.dbPath)).toBe(false)
    expect(readyOf(stream)).toMatchObject({ ownerHostId, afterSeq: 0, latestSeq: 0 })

    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    await stream.waitFor((frame) => frame.type === 'change', 'first change')

    expect(changeSeqs(stream)).toEqual(await durableSeqs(harness, ownerHostId))
    expect(JSON.stringify(stream.frames)).not.toContain('payload')
  })

  it('catches a backlog up in ordered pages and shows a commit made during catch-up exactly once', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    seedUntilHead(ledger, ownerHostId, 230)
    const ingress = await openWebhookIngress(harness)

    const stream = harness.stream('forgeInbox.subscribeChanges', { ownerHostId, afterSeq: 0 })
    await ingress.deliver()
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')
    const durable = await durableSeqs(harness, ownerHostId)
    await stream.waitFor((frame) => frame.seq === durable.at(-1), 'last durable change')
    await settle()

    expect(durable.length).toBeGreaterThan(230)
    expect(changeSeqs(stream)).toEqual(durable)
    const ready = readyOf(stream)
    expect(stream.frames.indexOf(ready)).toBeGreaterThan(-1)
    expect(Number(ready.latestSeq)).toBeLessThanOrEqual(durable.at(-1)!)
  })

  it('starts from the stored cursor when afterSeq is omitted and from afterSeq when given', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const durable = await durableSeqs(harness, ownerHostId)

    const explicit = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId, afterSeq: durable[0] },
      { connectionId: 'c-explicit' }
    )
    await explicit.waitFor((frame) => frame.type === 'ready', 'ready')
    expect(changeSeqs(explicit)).toEqual(durable.slice(1))
    expect(readyOf(explicit)).toMatchObject({ afterSeq: durable[0] })

    const fresh = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-fresh'
      }
    )
    await fresh.waitFor((frame) => frame.type === 'ready', 'ready')
    expect(changeSeqs(fresh)).toEqual(durable)
  })

  it('emits readState only to the reader whose mark changed, never as an activity change', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const { itemId } = seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const a = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        caller: 'paired-a',
        connectionId: 'c-a'
      }
    )
    const b = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        caller: 'paired-b',
        connectionId: 'c-b'
      }
    )
    await a.waitFor((frame) => frame.type === 'ready', 'a ready')
    await b.waitFor((frame) => frame.type === 'ready', 'b ready')
    const activityBefore = changeSeqs(a).length

    expect(
      await harness.ok('forgeInbox.markRead', { ownerHostId, itemId }, 'paired-a')
    ).toMatchObject({ marked: true })
    await a.waitFor((frame) => frame.type === 'readState', 'a readState')
    await settle()

    expect(b.frames.some((frame) => frame.type === 'readState')).toBe(false)
    expect(changeSeqs(a).length).toBe(activityBefore)
    expect(changeSeqs(b).length).toBe(activityBefore)
  })

  it('keeps a closed subscriber from breaking the committed write or other subscribers', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const survivor = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-ok'
      }
    )
    const doomed = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-gone'
      }
    )
    await survivor.waitFor((frame) => frame.type === 'ready', 'ready')
    await doomed.waitFor((frame) => frame.type === 'ready', 'ready')
    harness.runtime.cleanupSubscriptionsForConnection('c-gone')
    await doomed.done

    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    const durable = await durableSeqs(harness, ownerHostId)
    await survivor.waitFor((frame) => frame.seq === durable.at(-1), 'survivor catches up')
    expect(changeSeqs(survivor)).toEqual(durable)
    expect(changeSeqs(doomed)).toEqual([])
  })

  it('ends only a subscriber whose sink throws and leaves the committed write and others intact', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const survivor = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-ok'
      }
    )
    const broken = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-broken',
        failOnChange: true
      }
    )
    await survivor.waitFor((frame) => frame.type === 'ready', 'ready')
    await broken.waitFor((frame) => frame.type === 'ready', 'ready')

    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    await broken.done

    const durable = await durableSeqs(harness, ownerHostId)
    await survivor.waitFor((frame) => frame.seq === durable.at(-1), 'survivor change')
    expect(durable.length).toBeGreaterThan(0)
    expect(broken.frames.at(-1)).toMatchObject({ type: 'end', reason: 'failed' })
  })

  it('releases its hint listener when the stream closes', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const service = harness.runtime.forgeInboxService()
    const real = service.subscribeChangeHints.bind(service)
    const released = vi.fn()
    vi.spyOn(service, 'subscribeChangeHints').mockImplementation((listener) => {
      const unsubscribe = real(listener)
      return () => {
        released()
        unsubscribe()
      }
    })
    const stream = harness.stream('forgeInbox.subscribeChanges', { ownerHostId })
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')
    expect(released).not.toHaveBeenCalled()

    stream.abort()
    await stream.done

    expect(released).toHaveBeenCalledTimes(1)
  })

  it('ends the stream with a reason when the owner stops and binds nothing to a replacement', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const stream = harness.stream('forgeInbox.subscribeChanges', { ownerHostId })
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')

    await harness.stop()
    await stream.waitFor((frame) => frame.type === 'end', 'end')
    await stream.done

    expect(stream.frames.at(-1)).toMatchObject({ type: 'end', reason: 'stopped' })
    const framesAtEnd = stream.frames.length
    await settle()
    expect(stream.frames).toHaveLength(framesAtEnd)
    const late = harness.openLedger(ownerHostId)
    seedItem(late, ownerHostId, 9)
    await settle()
    expect(stream.frames).toHaveLength(framesAtEnd)
  })

  it('cleans up on abort so later commits reach nobody and the id is unusable', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    const stream = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        connectionId: 'c-abort'
      }
    )
    await stream.waitFor((frame) => frame.type === 'ready', 'ready')
    const { subscriptionId } = readyOf(stream)

    stream.abort()
    await stream.done
    const ingress = await openWebhookIngress(harness)
    await ingress.deliver()
    await settle()

    expect(changeSeqs(stream)).toEqual([])
    expect(
      await harness.ok('forgeInbox.unsubscribeChanges', { subscriptionId }, 'cli', 'c-abort')
    ).toMatchObject({ unsubscribed: true })
  })
})
