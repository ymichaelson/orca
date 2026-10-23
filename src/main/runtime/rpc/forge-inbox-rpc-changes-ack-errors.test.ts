import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  changeSeqs,
  createStreamHarness,
  durableSeqs,
  readyOf
} from './forge-inbox-rpc-change-stream-test-kit'
import { configure, errorCodeOf, seedItem, type ForgeRpcHarness } from './forge-inbox-rpc-test-kit'

describe('forge inbox rpc ack error classification', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  async function subscribed(ownerHostId: string, connectionId: string) {
    const stream = harness.stream(
      'forgeInbox.subscribeChanges',
      { ownerHostId },
      {
        caller: 'paired-a',
        connectionId
      }
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

  it('reports a storage failure as unavailable, not as a bad cursor, and releases nothing', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const { stream, subscriptionId } = await subscribed(ownerHostId, 'c-1')
    const seq = changeSeqs(stream).at(-1)!

    const side = new Database(harness.dbPath)
    let failed
    try {
      side.exec('ALTER TABLE client_cursors RENAME TO client_cursors_hidden')
      failed = await ack(ownerHostId, subscriptionId, seq, 'c-1')
    } finally {
      side.exec('ALTER TABLE client_cursors_hidden RENAME TO client_cursors')
      side.close()
    }

    expect(errorCodeOf(failed)).toBe('forge_inbox_unavailable')
    expect(JSON.stringify(failed)).not.toContain('client_cursors')
    const fresh = await subscribed(ownerHostId, 'c-2')
    expect(changeSeqs(fresh.stream)).toEqual(await durableSeqs(harness, ownerHostId))
    expect(
      await harness.ok(
        'forgeInbox.ackChanges',
        { ownerHostId, subscriptionId, seq },
        'paired-a',
        'c-1'
      )
    ).toEqual({
      cursor: seq
    })
  })

  it('still reports a sequence beyond what was sent as an invalid cursor', async () => {
    harness = await createStreamHarness()
    const ownerHostId = await configure(harness)
    seedItem(harness.openLedger(ownerHostId), ownerHostId, 1)
    const { stream, subscriptionId } = await subscribed(ownerHostId, 'c-1')

    const response = await ack(ownerHostId, subscriptionId, changeSeqs(stream).at(-1)! + 1, 'c-1')

    expect(errorCodeOf(response)).toBe('forge_inbox_invalid_cursor')
  })
})
