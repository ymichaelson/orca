import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeEventIngest } from './forge-inbox-types'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const OTHER_PROJECT = '43'

function event(iid: number, overrides: Partial<ForgeEventIngest> = {}): ForgeEventIngest {
  return {
    hostId: 'host-a',
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    kind: 'merge_request',
    iid,
    dedupeKey: `delivery-${iid}-${overrides.kind ?? 'merge_request'}-${overrides.projectId ?? PROJECT_ID}`,
    eventKind: 'merge_request.updated',
    payload: { n: 1 },
    versionToken: 'v1',
    sourceOrder: 1,
    title: `Item ${iid}`,
    itemState: 'opened',
    ...overrides
  }
}

describe('forge inbox list filters', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
  })
  afterEach(() => harness.dispose())

  function ingest(iid: number, overrides: Partial<ForgeEventIngest> = {}): number {
    const result = ledger.ingestEvent(event(iid, overrides))
    if (result.duplicate) {
      throw new Error('unexpected duplicate')
    }
    return result.itemId
  }

  const ids = (query: { projectId?: string; kind?: 'merge_request' | 'issue' }) =>
    ledger.listItems({ ...SCOPE, clientId: 'reader-1', ...query }).rows.map((row) => row.id)

  it('narrows to one project, one kind, or both, without touching the rest', () => {
    const here = ingest(1)
    const elsewhere = ingest(2, { projectId: OTHER_PROJECT, dedupeKey: 'other-mr' })
    const issue = ingest(1, { kind: 'issue', eventKind: 'issue.updated', dedupeKey: 'issue-1' })

    expect(ids({})).toEqual([issue, elsewhere, here])
    expect(ids({ projectId: OTHER_PROJECT })).toEqual([elsewhere])
    expect(ids({ kind: 'issue' })).toEqual([issue])
    expect(ids({ projectId: PROJECT_ID, kind: 'merge_request' })).toEqual([here])
    expect(ids({ projectId: OTHER_PROJECT, kind: 'issue' })).toEqual([])
  })

  it('pages inside the filtered set, so a page is never short of matching rows', () => {
    const first = ingest(1)
    ingest(2, { projectId: OTHER_PROJECT, dedupeKey: 'other-mr' })
    const second = ingest(3)

    const page1 = ledger.listItems({
      ...SCOPE,
      clientId: 'reader-1',
      projectId: PROJECT_ID,
      limit: 1
    })
    const page2 = ledger.listItems({
      ...SCOPE,
      clientId: 'reader-1',
      projectId: PROJECT_ID,
      limit: 1,
      cursor: page1.nextCursor ?? undefined
    })

    expect(page1.rows.map((row) => row.id)).toEqual([second])
    expect(page2.rows.map((row) => row.id)).toEqual([first])
    expect(page2.nextCursor).toBeNull()
  })

  it('names every project this host holds an item for', () => {
    ingest(1)
    ingest(2, { projectId: OTHER_PROJECT, dedupeKey: 'other-mr' })
    ingest(3, { dedupeKey: 'third-item' })

    expect(ledger.listItemProjects()).toEqual([PROJECT_ID, OTHER_PROJECT])
  })
})
