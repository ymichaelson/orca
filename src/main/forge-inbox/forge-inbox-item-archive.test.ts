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

function event(iid: number, overrides: Partial<ForgeEventIngest> = {}): ForgeEventIngest {
  return {
    hostId: 'host-a',
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    kind: 'merge_request',
    iid,
    dedupeKey: `delivery-${iid}-v1`,
    eventKind: 'merge_request.updated',
    payload: { n: 1 },
    versionToken: 'v1',
    sourceOrder: 1,
    title: `MR ${iid}`,
    itemState: 'opened',
    ...overrides
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('forge inbox per-reader archive', () => {
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

  function ingest(iid: number, overrides: Partial<ForgeEventIngest> = {}): number {
    const result = ledger.ingestEvent(event(iid, overrides))
    if (result.duplicate) {
      throw new Error('unexpected duplicate')
    }
    return result.itemId
  }

  const ids = (clientId: string, archiveView?: 'active' | 'archived' | 'all') =>
    ledger
      .listItems({ ...SCOPE, clientId, ...(archiveView ? { archiveView } : {}) })
      .rows.map((row) => row.id)
  const head = () => ledger.listChanges(SCOPE, { afterSeq: 0, limit: 100 }).nextSeq

  it('hides an archived item for that reader only and lists it under the archived view', () => {
    const a = ingest(1)
    const b = ingest(2)

    expect(ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)

    expect(ids('reader-1')).toEqual([b])
    expect(ids('reader-1', 'archived')).toEqual([a])
    expect(ids('reader-1', 'all')).toEqual([b, a])
    expect(ids('reader-2')).toEqual([b, a])
    expect(ids('reader-2', 'archived')).toEqual([])
    const flagged = ledger.listItems({ ...SCOPE, clientId: 'reader-1', archiveView: 'all' }).rows
    expect(flagged.map((row) => row.archived)).toEqual([false, true])
  })

  it('pages the archived filter on the host so no page is short', () => {
    const first = ingest(1)
    const second = ingest(2)
    const third = ingest(3)
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: second })

    const page1 = ledger.listItems({ ...SCOPE, clientId: 'reader-1', limit: 1 })
    const page2 = ledger.listItems({
      ...SCOPE,
      clientId: 'reader-1',
      limit: 1,
      cursor: page1.nextCursor ?? undefined
    })

    expect(page1.rows.map((row) => row.id)).toEqual([third])
    expect(page2.rows.map((row) => row.id)).toEqual([first])
    expect(page2.nextCursor).toBeNull()
  })

  it('fences the archive to the owner instance and an existing item', () => {
    const a = ingest(1)

    expect(ledger.archiveItem({ instanceId: 'other' }, { clientId: 'reader-1', itemId: a })).toBe(
      false
    )
    expect(ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a + 99 })).toBe(false)
    expect(ledger.unarchiveItem({ instanceId: 'other' }, { clientId: 'reader-1', itemId: a })).toBe(
      false
    )
    expect(side.prepare('SELECT COUNT(*) AS n FROM item_archives').get()?.n).toBe(0)
  })

  it('hints only the archiving reader once, without advancing activity or the change feed', async () => {
    const a = ingest(1)
    await settle()
    hints.length = 0
    const before = head()
    const activity = ledger.listItems({ ...SCOPE, clientId: 'reader-1' }).rows[0].activitySeq

    expect(ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: false, readClientIds: ['reader-1'] }])

    hints.length = 0
    expect(ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)
    await settle()
    expect(hints).toEqual([])
    expect(head()).toBe(before)
    expect(ledger.listItems({ ...SCOPE, clientId: 'reader-2' }).rows[0].activitySeq).toBe(activity)
  })

  it('restores an item on unarchive and stays silent on a repeat', async () => {
    const a = ingest(1)
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })
    await settle()
    hints.length = 0

    expect(ledger.unarchiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)
    await settle()
    expect(hints).toEqual([{ changes: false, readClientIds: ['reader-1'] }])
    expect(ids('reader-1')).toEqual([a])

    hints.length = 0
    expect(ledger.unarchiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)
    await settle()
    expect(hints).toEqual([])
  })

  it('shows an archived item again once it has newer activity', () => {
    const a = ingest(1)
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })
    expect(ids('reader-1')).toEqual([])

    ingest(1, { dedupeKey: 'delivery-1-v2', versionToken: 'v2', sourceOrder: 2 })

    expect(ids('reader-1')).toEqual([a])
    expect(ids('reader-1', 'archived')).toEqual([])
    expect(ledger.listItems({ ...SCOPE, clientId: 'reader-1' }).rows[0].archived).toBe(false)
  })

  it('archives again at the newer activity after a reactivation', () => {
    const a = ingest(1)
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })
    ingest(1, { dedupeKey: 'delivery-1-v2', versionToken: 'v2', sourceOrder: 2 })

    expect(ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })).toBe(true)

    expect(ids('reader-1')).toEqual([])
    expect(ids('reader-1', 'archived')).toEqual([a])
  })

  it('keeps read and archive independent', () => {
    const a = ingest(1)

    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })
    expect(
      ledger.listItems({ ...SCOPE, clientId: 'reader-1', archiveView: 'archived' }).rows[0].unread
    ).toBe(true)

    ledger.markRead(SCOPE, { clientId: 'reader-1', itemId: a })
    const archived = ledger.listItems({ ...SCOPE, clientId: 'reader-1', archiveView: 'archived' })
    expect(archived.rows.map((row) => [row.id, row.unread])).toEqual([[a, false]])
    expect(ids('reader-1')).toEqual([])
  })

  it('combines the unread filter with the archive view', () => {
    const a = ingest(1)
    const b = ingest(2)
    ledger.markRead(SCOPE, { clientId: 'reader-1', itemId: a })
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: b })

    const unreadAll = ledger.listItems({
      ...SCOPE,
      clientId: 'reader-1',
      unreadOnly: true,
      archiveView: 'all'
    })
    const unreadActive = ledger.listItems({ ...SCOPE, clientId: 'reader-1', unreadOnly: true })

    expect(unreadAll.rows.map((row) => row.id)).toEqual([b])
    expect(unreadActive.rows).toEqual([])
  })

  it('never deletes events or runs and emits nothing when the write rolls back', async () => {
    const a = ingest(1, { queueRun: { reason: 'x' } })
    await settle()
    const counts = () =>
      side
        .prepare('SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT COUNT(*) FROM runs) AS r')
        .get()
    const before = counts()
    ledger.archiveItem(SCOPE, { clientId: 'reader-1', itemId: a })
    expect(counts()).toEqual(before)

    side.exec(
      `CREATE TRIGGER block_archive BEFORE INSERT ON item_archives
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`
    )
    await settle()
    hints.length = 0
    expect(() => ledger.archiveItem(SCOPE, { clientId: 'reader-2', itemId: a })).toThrow()
    await settle()
    expect(hints).toEqual([])
    expect(ids('reader-2')).toEqual([a])
  })
})
