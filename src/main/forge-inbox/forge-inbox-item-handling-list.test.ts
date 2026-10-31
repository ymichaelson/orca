import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { seedDispatchRun } from './forge-inbox-dispatch-confirmation-test-kit'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem
} from './forge-inbox-project-event-action'
import { settleProjectEventAction } from './forge-inbox-project-event-action-settle'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'
import type { ForgeItemHandlingState } from '../../shared/forge-inbox-item-handling'

describe('Inbox list narrowed by handling state', () => {
  let fixture: ProjectEventQuestionFixture
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-handling-list-')
    ctx = fixture.ctx
  })
  afterEach(() => fixture.close())

  /** An item that only holds hook events, so its derived state stays `recorded`. */
  function recordedItem(iid: number): number {
    const ingested = ingestForgeEventInTransaction(ctx, {
      hostId: ctx.hostId,
      instanceId: 'inst-1',
      projectId: 'project-1',
      kind: 'merge_request',
      iid,
      dedupeKey: `dedupe-${iid}`,
      eventKind: 'Merge Request Hook',
      versionToken: `sha-${iid}`,
      sourceOrder: 1,
      payload: {}
    })
    if (ingested.duplicate) {
      throw new Error('expected a first delivery')
    }
    return ingested.itemId
  }

  /** Drives a delivery through the real decision, claim and settle path to a handled item. */
  function handledItem(): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId: fixture.bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${randomUUID()}`,
      correlation: { eventUuid: null, configUuid: null },
      body: projectEventQuestionBody()
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const decision = claimProjectEventDecision(ctx)
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    const decided = decideProjectEventDelivery(
      ctx,
      admitted.deliveryId,
      projectEventQuestionDecision('notify'),
      decision
    )
    if (!decided.ok) {
      throw new Error('fixture could not record the decision')
    }
    const claim = claimProjectEventAction(ctx)
    if (!claim) {
      throw new Error('expected a project event action claim')
    }
    const linked = linkProjectEventDecisionItem(ctx, claim)
    if (!linked.ok) {
      throw new Error(`fixture could not link the item: ${linked.reason}`)
    }
    const settled = settleProjectEventAction(ctx, claim, { kind: 'done' })
    if (!settled.ok) {
      throw new Error('fixture could not settle the action')
    }
    return linked.itemId
  }

  function listedIds(handling: ForgeItemHandlingState, limit?: number): number[] {
    return fixture.ledger
      .listItems({ clientId: 'reader-1', handling, ...(limit === undefined ? {} : { limit }) })
      .rows.map((row) => row.id)
  }

  it('keeps only items whose derived state matches, reading past the ones that do not', () => {
    const handled = handledItem()
    const newer = [recordedItem(11), recordedItem(12)]

    // Why: the handled item is the oldest row, so a first-page-only filter would miss it.
    expect(listedIds('done')).toEqual([handled])
    expect(listedIds('recorded')).toEqual(newer.toReversed())
    expect(
      fixture.ledger.listItems({ clientId: 'reader-1', handling: 'done' }).nextCursor
    ).toBeNull()
  })

  it('pages inside the matching set instead of skipping to the next matching page', () => {
    const first = recordedItem(21)
    const second = recordedItem(22)
    handledItem()

    const page = fixture.ledger.listItems({ clientId: 'reader-1', handling: 'recorded', limit: 1 })
    expect(page.rows.map((row) => row.id)).toEqual([second])
    expect(page.nextCursor).not.toBeNull()

    const next = fixture.ledger.listItems({
      clientId: 'reader-1',
      handling: 'recorded',
      limit: 1,
      cursor: page.nextCursor ?? undefined
    })
    expect(next.rows.map((row) => row.id)).toEqual([first])
    expect(next.nextCursor).toBeNull()
  })

  it('answers an empty page for a state no item is in', () => {
    recordedItem(31)

    expect(listedIds('failed')).toEqual([])
    expect(
      fixture.ledger.listItems({ clientId: 'reader-1', handling: 'failed' }).nextCursor
    ).toBeNull()
  })

  it('labels a row with the recommendation its newest run made', () => {
    const seeded = seedDispatchRun(ctx, {
      binding: { bindingId: randomUUID(), gitlabHost: 'gitlab.test', gitlabProjectId: 3 },
      report: {
        status: 'claims',
        mode: 'read-only',
        claims: [],
        recommendation: { action: 'merge', reason: 'Docs only.' }
      },
      storedIid: 77,
      itemState: 'opened'
    })

    const rows = fixture.ledger.listItems({ clientId: 'reader-1' }).rows
    expect(rows.find((row) => row.id === seeded.itemId)).toMatchObject({
      latestRunState: 'succeeded',
      recommendationAction: 'merge'
    })
  })
})
