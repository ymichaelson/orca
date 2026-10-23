import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { changeSeqs, createStreamHarness, settle } from './forge-inbox-rpc-change-stream-test-kit'
import { seedItem, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc changes stream owner race', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  it.each([
    ['the stored cursor', {}],
    ['an explicit afterSeq', { afterSeq: 0 }]
  ])(
    'serves no rows labelled with the old owner when a lazy open changes the owner (%s)',
    async (_name, extra) => {
      harness = await createStreamHarness()
      const dormantOwner = String((await harness.ok('forgeInbox.getConfig', {})).ownerHostId)
      const other = harness.openLedger('another-owner')
      seedItem(other, 'another-owner', 1)
      const service = harness.runtime.forgeInboxService()
      const realOwnerHostId = service.ownerHostId.bind(service)
      let opened = false
      service.ownerHostId = () => {
        const answer = realOwnerHostId()
        if (!opened) {
          opened = true
          // The first fence passes with the dormant id; this write then opens the other owner's ledger.
          void service
            .updateConfig(0, { schemaVersion: 1, listener: {}, instances: [] })
            .catch(() => undefined)
        }
        return answer
      }

      const stream = harness.stream(
        'forgeInbox.subscribeChanges',
        { ownerHostId: dormantOwner, ...extra },
        { caller: 'paired-a', connectionId: 'c-race' }
      )
      await stream.done
      await settle()

      expect(opened).toBe(true)
      expect(stream.errors).toEqual(['forge_inbox_owner_mismatch'])
      expect(changeSeqs(stream)).toEqual([])
      expect(stream.frames.some((frame) => frame.type === 'ready')).toBe(false)
    }
  )
})
