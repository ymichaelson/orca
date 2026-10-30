import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { answerProjectEventQuestion } from './forge-inbox-project-event-question-answer'
import {
  openQuestionPreparationHarness,
  PREPARED_QUESTION
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  openProjectEventQuestionFixture,
  PROJECT_EVENT_TEST_REPO_ID,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { rowNumber } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

describe('project event question answer race', () => {
  let fixture: ProjectEventQuestionFixture
  let ctx: ForgeLedgerContext
  let bindingId: string

  function admit(): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
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

  function ask(): number {
    const deliveryId = admit()
    const decision = claimProjectEventDecision(ctx)
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    if (
      !decideProjectEventDelivery(
        ctx,
        deliveryId,
        projectEventQuestionDecision('ask_user'),
        decision
      ).ok
    ) {
      throw new Error('fixture could not record the decision')
    }
    return deliveryId
  }

  function deliveryRow() {
    const row = ctx.db
      .prepare(
        `SELECT state, decision_state, parked_reason, attempts, policy_generation
         FROM webhook_deliveries WHERE id = 1`
      )
      .get()
    if (!row) {
      throw new Error('expected the delivery')
    }
    return row
  }

  function latestDecision() {
    const row = ctx.db
      .prepare(
        `SELECT id, superseded, action_state FROM project_event_decisions
         ORDER BY id DESC LIMIT 1`
      )
      .get()
    if (!row) {
      throw new Error('expected a decision')
    }
    return row
  }

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-answer-race-')
    ctx = fixture.ctx
    bindingId = fixture.bindingId
  })

  afterEach(() => fixture.close())

  it('records the answer without requeueing a delivery a policy change already requeued', async () => {
    ask()
    const harness = openQuestionPreparationHarness(fixture.ledger)
    try {
      expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
      await harness.complete()
    } finally {
      harness.dispose()
    }
    const question = ctx.db.prepare('SELECT id FROM project_event_questions').get()
    if (!question) {
      throw new Error('expected an open question')
    }

    updateProjectEventPolicy(ctx, {
      repoId: PROJECT_EVENT_TEST_REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: true, rules: 'rules-2' }
    })
    if (!claimProjectEventDecision(ctx)) {
      throw new Error('expected the requeued delivery to be claimable')
    }
    const claimed = latestDecision()
    expect(deliveryRow()).toMatchObject({
      state: 'pending',
      decision_state: 'processing',
      attempts: 1
    })

    expect(
      answerProjectEventQuestion(ctx, {
        ownerHostId: ctx.hostId,
        questionId: rowNumber(question, 'id'),
        answer: 'ship it after the tests pass'
      })
    ).toMatchObject({ ok: true })

    expect(deliveryRow()).toMatchObject({
      state: 'pending',
      decision_state: 'processing',
      attempts: 1,
      parked_reason: null
    })
    expect(latestDecision()).toEqual(claimed)

    updateProjectEventPolicy(ctx, {
      repoId: PROJECT_EVENT_TEST_REPO_ID,
      expectedGeneration: 2,
      patch: { enabled: true, rules: 'rules-3' }
    })
    const next = claimProjectEventDecision(ctx)
    if (!next) {
      throw new Error('expected the next decision to be claimable')
    }
    // A policy generation change is its own decision round, so the earlier answer never reaches it.
    expect(next.input.context).not.toHaveProperty('answers')
    expect(ctx.db.prepare('SELECT question, answer FROM project_event_questions').get()).toEqual({
      question: PREPARED_QUESTION,
      answer: 'ship it after the tests pass'
    })
  })
})
