import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeSeqs,
  createStreamHarness,
  durableSeqs,
  openWebhookIngress,
  readyOf,
  settle
} from './forge-inbox-rpc-change-stream-test-kit'
import { configure, errorCodeOf, seedItem, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc changes stream sink failure', () => {
  let harness: ForgeRpcHarness
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled)
    vi.restoreAllMocks()
    await harness.close()
  })

  const triggers = {
    'a live change': async (ownerHostId: string) => {
      await (await openWebhookIngress(harness)).deliver()
      return ownerHostId
    },
    'a read mark': async (ownerHostId: string) => {
      await harness.ok('forgeInbox.markRead', { ownerHostId, itemId: 1 }, 'paired-a')
      return ownerHostId
    },
    'an owner stop': async (ownerHostId: string) => {
      await harness.stop()
      return ownerHostId
    }
  }

  it.each(['a live change', 'a read mark', 'an owner stop'] as const)(
    'fully releases a stream whose sink rejects every frame after ready on %s',
    async (name) => {
      process.on('unhandledRejection', onUnhandled)
      harness = await createStreamHarness()
      const ownerHostId = await configure(harness)
      seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
      const service = harness.runtime.forgeInboxService()
      const real = service.subscribeChangeHints.bind(service)
      const released: boolean[] = []
      vi.spyOn(service, 'subscribeChangeHints').mockImplementation((listener) => {
        const index = released.push(false) - 1
        const unsubscribe = real(listener)
        return () => {
          released[index] = true
          unsubscribe()
        }
      })
      const broken = harness.stream(
        'forgeInbox.subscribeChanges',
        { ownerHostId },
        {
          caller: 'paired-a',
          connectionId: 'c-broken',
          failAfterReady: true
        }
      )
      const survivor = harness.stream(
        'forgeInbox.subscribeChanges',
        { ownerHostId },
        {
          caller: 'paired-b',
          connectionId: 'c-ok'
        }
      )
      await broken.waitFor((frame) => frame.type === 'ready', 'broken ready')
      await survivor.waitFor((frame) => frame.type === 'ready', 'survivor ready')
      const brokenId = readyOf(broken).subscriptionId

      await triggers[name](ownerHostId)
      await broken.done
      await settle()

      expect(released).toEqual([true, name === 'an owner stop'])
      const ack = await harness.call(
        'forgeInbox.ackChanges',
        { ownerHostId, subscriptionId: brokenId, seq: 0 },
        'paired-a',
        'c-broken'
      )
      expect(errorCodeOf(ack)).toBe('forge_inbox_invalid_subscription')
      if (name === 'an owner stop') {
        await survivor.waitFor((frame) => frame.type === 'end', 'survivor end')
      } else {
        const durable = await durableSeqs(harness, ownerHostId)
        await survivor.waitFor((frame) => frame.seq === durable.at(-1), 'survivor change')
        expect(changeSeqs(survivor)).toEqual(durable)
      }
      expect(unhandled).toEqual([])
    }
  )
})
