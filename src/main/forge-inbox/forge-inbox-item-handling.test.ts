import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem,
  type ProjectEventActionClaim
} from './forge-inbox-project-event-action'
import { settleProjectEventAction } from './forge-inbox-project-event-action-settle'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import { readForgeItemHandling } from './forge-inbox-item-handling'
import { getForgeItemDetail } from './forge-inbox-queries'
import {
  openQuestionPreparationHarness,
  type QuestionPreparationHarness
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { rowNumber, rowText } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

describe('Inbox item handling', () => {
  let fixture: ProjectEventQuestionFixture
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-item-handling-')
    ctx = fixture.ctx
  })

  afterEach(() => {
    fixture.close()
  })

  function admit(): number {
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
    return admitted.deliveryId
  }

  function decide(action: ProjectEventDecisionAction): number {
    const deliveryId = admit()
    const decision = claimProjectEventDecision(ctx)
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    const result = decideProjectEventDelivery(
      ctx,
      deliveryId,
      projectEventQuestionDecision(action),
      decision
    )
    if (!result.ok) {
      throw new Error('fixture could not record the decision')
    }
    return deliveryId
  }

  /** Runs the preparation through the real drain, launcher and run watch so production publishes it. */
  async function askUser(): Promise<void> {
    const harness: QuestionPreparationHarness = openQuestionPreparationHarness(fixture.ledger)
    try {
      expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
      await harness.complete()
    } finally {
      harness.dispose()
    }
  }

  /** Claims and links without settling, the exact point where an action is in flight. */
  function claimLinked(): { claim: ProjectEventActionClaim; itemId: number } {
    const claim = claimProjectEventAction(ctx)
    if (!claim) {
      throw new Error('expected a project event action claim')
    }
    const linked = linkProjectEventDecisionItem(ctx, claim)
    if (!linked.ok) {
      throw new Error(`fixture could not link the item: ${linked.reason}`)
    }
    return { claim, itemId: linked.itemId }
  }

  function settle(
    claim: ProjectEventActionClaim,
    outcome: Parameters<typeof settleProjectEventAction>[2]
  ): void {
    const settled = settleProjectEventAction(ctx, claim, outcome)
    if (!settled.ok) {
      throw new Error('fixture could not settle the action')
    }
  }

  function deliveryState(deliveryId: number): string {
    const row = ctx.db.prepare('SELECT state FROM webhook_deliveries WHERE id = ?').get(deliveryId)
    if (!row) {
      throw new Error('expected the delivery row')
    }
    return rowText(row, 'state')
  }

  it('reports an open question as needs-user, through the detail read too', async () => {
    decide('ask_user')
    await askUser()
    const row = ctx.db.prepare('SELECT item_id FROM project_event_questions').get()
    if (!row) {
      throw new Error('expected an open question')
    }
    const itemId = rowNumber(row, 'item_id')

    expect(readForgeItemHandling(ctx, itemId)).toEqual({ state: 'needs-user', errorCode: null })
    const detail = getForgeItemDetail(ctx, SCOPE, itemId, 'client-1')
    expect(detail?.handling).toEqual({ state: 'needs-user', errorCode: null })
  })

  it('reports processing while the action is in flight and waiting once it parks', () => {
    decide('wait')
    const { claim, itemId } = claimLinked()
    expect(readForgeItemHandling(ctx, itemId).state).toBe('processing')

    settle(claim, { kind: 'awaiting-event', waitReason: 'conflict-resolved' })
    expect(readForgeItemHandling(ctx, itemId)).toEqual({ state: 'waiting', errorCode: null })
  })

  it('reports a blocked action as failed with the code the host recorded', () => {
    const deliveryId = decide('wait')
    const { claim, itemId } = claimLinked()
    settle(claim, { kind: 'blocked', code: 'invalid-input' })

    expect(deliveryState(deliveryId)).toBe('failed')
    expect(readForgeItemHandling(ctx, itemId)).toEqual({
      state: 'failed',
      errorCode: 'invalid-input'
    })
  })

  it('reports a settled non-record action as handled', () => {
    decide('notify')
    const { claim, itemId } = claimLinked()
    settle(claim, { kind: 'done' })

    expect(readForgeItemHandling(ctx, itemId)).toEqual({ state: 'done', errorCode: null })
  })

  it('reads a refused duplicate dispatch as handled when the change already ran', () => {
    decide('dispatch_agent')
    const { claim, itemId } = claimLinked()
    ctx.db
      .prepare(`INSERT INTO runs (item_id, revision, state, policy_generation, context_digest,
        analysis_kind, reason, created_at, updated_at)
        VALUES (?, 1, 'succeeded', 1, 'digest', 'merge_request', 'review-requested', 1, 1)`)
      .run(itemId)
    settle(claim, { kind: 'blocked', code: 'already-dispatched' })

    // Anything that actually failed still reads as failed; only the duplicate refusal is not one.
    expect(readForgeItemHandling(ctx, itemId)).toEqual({ state: 'done', errorCode: null })
  })

  it('reports an unverifiable run as unconfirmed rather than handled', () => {
    decide('notify')
    const { claim, itemId } = claimLinked()
    settle(claim, { kind: 'done' })
    ctx.db
      .prepare(`INSERT INTO runs (item_id, revision, state, policy_generation, context_digest,
        analysis_kind, reason, created_at, updated_at)
        VALUES (?, 1, 'unverifiable', 1, 'digest', 'merge_request', 'review-requested', 1, 1)`)
      .run(itemId)

    expect(readForgeItemHandling(ctx, itemId)).toEqual({
      state: 'unconfirmed',
      errorCode: null
    })
  })

  it('reports an item that only holds recorded events as recorded', () => {
    const ingested = ingestForgeEventInTransaction(ctx, {
      hostId: ctx.hostId,
      instanceId: 'inst-1',
      projectId: 'project-1',
      kind: 'merge_request',
      iid: 9,
      dedupeKey: 'dedupe-9',
      eventKind: 'Merge Request Hook',
      versionToken: 'sha-9',
      sourceOrder: 1,
      payload: {}
    })
    if (ingested.duplicate) {
      throw new Error('fixture expected a first delivery')
    }

    expect(readForgeItemHandling(ctx, ingested.itemId)).toEqual({
      state: 'recorded',
      errorCode: null
    })
  })

  it('keeps needs-user above a later failed delivery on the same item', async () => {
    decide('ask_user')
    await askUser()
    const question = ctx.db.prepare('SELECT item_id FROM project_event_questions').get()
    if (!question) {
      throw new Error('expected an open question')
    }
    const itemId = rowNumber(question, 'item_id')

    const failedDelivery = decide('wait')
    const { claim, itemId: failedItemId } = claimLinked()
    expect(failedItemId).toBe(itemId)
    settle(claim, { kind: 'blocked', code: 'invalid-input' })

    expect(deliveryState(failedDelivery)).toBe('failed')
    expect(readForgeItemHandling(ctx, itemId)).toEqual({ state: 'needs-user', errorCode: null })
  })
})
