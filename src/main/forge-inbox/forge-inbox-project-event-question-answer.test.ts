import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import { projectEventAnswerText } from '../../shared/forge-inbox-project-event-question'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { removeProjectEventRepoLink } from './forge-inbox-project-event-link'
import {
  openQuestionPreparationHarness,
  PREPARED_QUESTION
} from './forge-inbox-project-event-question-preparation-test-kit'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  answerProjectEventQuestion,
  listProjectEventQuestions,
  projectEventQuestionAnswers
} from './forge-inbox-project-event-question-answer'
import {
  openProjectEventQuestionFixture,
  PROJECT_EVENT_TEST_REPO_ID,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { rowNumber, rowText } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

describe('project event question answers', () => {
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

  function record(action: ProjectEventDecisionAction): number {
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

  async function ask(question = PREPARED_QUESTION): Promise<number> {
    record('ask_user')
    const harness = openQuestionPreparationHarness(fixture.ledger, { question })
    try {
      expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
      await harness.complete()
    } finally {
      harness.dispose()
    }
    const row = ctx.db.prepare('SELECT id FROM project_event_questions ORDER BY id').get()
    if (!row) {
      throw new Error('expected an open question')
    }
    return rowNumber(row, 'id')
  }

  function answer(questionId: number, text: string) {
    return answerProjectEventQuestion(ctx, {
      ownerHostId: ctx.hostId,
      questionId,
      answer: text
    })
  }

  function deliveryRow() {
    const row = ctx.db
      .prepare(
        `SELECT state, decision_state, parked_reason, attempts, policy_generation,
         last_error_code, finished_at, length(body) AS bytes FROM webhook_deliveries WHERE id = 1`
      )
      .get()
    if (!row) {
      throw new Error('expected the delivery')
    }
    return row
  }

  function questionRow() {
    const row = ctx.db
      .prepare(
        'SELECT question, status, answer, answered_at FROM project_event_questions WHERE id = 1'
      )
      .get()
    if (!row) {
      throw new Error('expected the question')
    }
    return row
  }

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-answer-')
    ctx = fixture.ctx
    bindingId = fixture.bindingId
  })

  afterEach(() => fixture.close())

  it('answers once, supersedes the old decision, and re-queues the delivery', async () => {
    const questionId = await ask()

    const result = answer(questionId, 'please continue')

    expect(result).toEqual({
      ok: true,
      question: {
        id: questionId,
        itemId: 1,
        question: PREPARED_QUESTION,
        subject: { kind: 'merge_request', iid: 7, title: 'Add thing' },
        source: 'answer',
        status: 'answered',
        askedAt: expect.any(Number),
        answeredAt: expect.any(Number)
      }
    })
    expect(questionRow()).toMatchObject({ status: 'answered', answer: 'please continue' })
    expect(deliveryRow()).toMatchObject({
      state: 'pending',
      decision_state: 'queued',
      parked_reason: null,
      attempts: 0,
      policy_generation: 1,
      last_error_code: null,
      finished_at: null
    })
    expect(rowNumber(deliveryRow(), 'bytes')).toBeGreaterThan(0)
    expect(
      ctx.db.prepare('SELECT superseded FROM project_event_decisions WHERE id = 1').get()
    ).toEqual({ superseded: 1 })
  })

  it('feeds the stored answer to the next decision as data, never as rules', async () => {
    const questionId = await ask()
    answer(questionId, 'ship it after the tests pass')

    const claimed = claimProjectEventDecision(ctx)
    if (!claimed) {
      throw new Error('expected the answered delivery to be claimable')
    }

    expect(claimed.input.context).toMatchObject({
      answers: [{ question: PREPARED_QUESTION, answer: 'ship it after the tests pass' }]
    })
    expect(claimed.input.rules).toBe('rules')
    expect(claimed.input.rules).not.toContain('ship it')
    expect(claimed.input.event).not.toHaveProperty('answers')
  })

  it('adds no answers key when the delivery has never been answered', () => {
    admit()

    const claimed = claimProjectEventDecision(ctx)
    if (!claimed) {
      throw new Error('expected the delivery to be claimable')
    }

    expect(claimed.input.context).not.toHaveProperty('answers')
  })

  // node:sqlite truncates a text value at NUL on read, bun:sqlite keeps it, so the read-side
  // normalization is proven on the function itself rather than through a DB round trip.
  it('strips NUL from stored answer text and keeps the byte bound', () => {
    expect(projectEventAnswerText('bad\u0000note')).toBe('badnote')
    expect(projectEventAnswerText('x'.repeat(2100))).toBe('x'.repeat(2000))
    expect(projectEventAnswerText('\u0000')).toBe('')
  })

  it('strips NUL from an answer and feeds it to the next decision', async () => {
    const questionId = await ask()
    expect(answer(questionId, 'ok\u0000')).toMatchObject({ ok: true })
    expect(rowText(questionRow(), 'answer')).toBe('ok')

    const claimed = claimProjectEventDecision(ctx)
    if (!claimed) {
      throw new Error('expected the delivery to be claimable')
    }

    expect(claimed.input.context).toMatchObject({
      answers: [{ question: PREPARED_QUESTION, answer: 'ok' }]
    })
  })

  it('refuses an oversized stored question instead of truncating it', async () => {
    const questionId = await ask()
    expect(answer(questionId, 'ok')).toMatchObject({ ok: true })
    expect(projectEventQuestionAnswers(ctx, 1, 1)).toEqual([
      { id: questionId, question: PREPARED_QUESTION, answer: 'ok' }
    ])

    ctx.db
      .prepare('UPDATE project_event_questions SET question = ? WHERE id = ?')
      .run('q'.repeat(4001), questionId)
    expect(() => projectEventQuestionAnswers(ctx, 1, 1)).toThrow('project_event_answers_too_large')
  })

  it('refuses a second answer and never re-queues the delivery twice', async () => {
    const questionId = await ask()
    expect(answer(questionId, 'first')).toMatchObject({ ok: true })

    // Claiming is the observable trace of the first re-queue; a second one would undo it.
    expect(claimProjectEventDecision(ctx)).not.toBeNull()
    expect(deliveryRow()).toMatchObject({ decision_state: 'processing', attempts: 1 })

    expect(answer(questionId, 'second')).toEqual({ ok: false, reason: 'not-found' })
    expect(questionRow()).toMatchObject({ answer: 'first' })
    expect(deliveryRow()).toMatchObject({
      state: 'pending',
      decision_state: 'processing',
      attempts: 1
    })
  })

  it('refuses an answer addressed to a different host', async () => {
    const questionId = await ask()

    expect(
      answerProjectEventQuestion(ctx, {
        ownerHostId: 'host-2',
        questionId,
        answer: 'yes'
      })
    ).toEqual({ ok: false, reason: 'not-found' })
    expect(questionRow()).toMatchObject({ status: 'open' })
    expect(deliveryRow()).toMatchObject({ state: 'parked', parked_reason: 'awaiting-user' })
  })

  it('refuses an empty or oversized answer without touching the question', async () => {
    const questionId = await ask()

    expect(answer(questionId, '')).toEqual({ ok: false, reason: 'question-answer-invalid' })
    expect(answer(questionId, 'x'.repeat(2001))).toEqual({
      ok: false,
      reason: 'question-answer-invalid'
    })
    expect(questionRow()).toMatchObject({ status: 'open' })
  })

  it('records the answer after the disabled-policy trigger already finished the delivery', async () => {
    const questionId = await ask()
    expect(
      updateProjectEventPolicy(ctx, {
        repoId: PROJECT_EVENT_TEST_REPO_ID,
        expectedGeneration: 1,
        patch: { enabled: false }
      })
    ).toMatchObject({ ok: true })
    expect(deliveryRow()).toMatchObject({ state: 'failed', last_error_code: 'policy-disabled' })

    expect(answer(questionId, 'yes')).toMatchObject({ ok: true })

    expect(questionRow()).toMatchObject({ status: 'answered' })
    expect(deliveryRow()).toMatchObject({
      state: 'failed',
      decision_state: 'cancelled',
      last_error_code: 'policy-disabled'
    })
    expect(rowNumber(deliveryRow(), 'bytes')).toBe(0)
    expect(deliveryRow().finished_at).not.toBeNull()
  })

  it('finishes an unlinked answer instead of parking it forever', async () => {
    const questionId = await ask()
    expect(removeProjectEventRepoLink(ctx, PROJECT_EVENT_TEST_REPO_ID)).toBe(true)
    expect(deliveryRow()).toMatchObject({ state: 'parked', parked_reason: 'awaiting-policy' })

    expect(answer(questionId, 'yes')).toMatchObject({ ok: true })

    expect(questionRow()).toMatchObject({ status: 'answered' })
    expect(deliveryRow()).toMatchObject({
      state: 'failed',
      decision_state: 'cancelled',
      last_error_code: 'missing-link'
    })
    expect(rowNumber(deliveryRow(), 'bytes')).toBe(0)
    expect(deliveryRow().finished_at).not.toBeNull()
  })

  it('asks at most one answered round per delivery', async () => {
    const questionId = await ask()
    answer(questionId, 'yes')
    const claimed = claimProjectEventDecision(ctx)
    if (!claimed) {
      throw new Error('expected the answered delivery to be claimable')
    }
    decideProjectEventDelivery(
      ctx,
      claimed.deliveryId,
      projectEventQuestionDecision('ask_user'),
      claimed
    )

    const harness = openQuestionPreparationHarness(fixture.ledger)
    try {
      expect(await harness.drain()).toEqual({ executed: 0, failed: 1, capped: false })
      expect(harness.probe.created).toEqual([])
    } finally {
      harness.dispose()
    }
    expect(listProjectEventQuestions(ctx, { ownerHostId: ctx.hostId })).toHaveLength(1)
    expect(
      ctx.db
        .prepare('SELECT last_error_code FROM project_event_decisions ORDER BY id DESC LIMIT 1')
        .get()
    ).toEqual({ last_error_code: 'question-rounds-exhausted' })
  })

  it('lists only the fixed projection for this host', async () => {
    await ask()

    expect(listProjectEventQuestions(ctx, { ownerHostId: ctx.hostId })).toEqual([
      {
        id: 1,
        itemId: 1,
        question: PREPARED_QUESTION,
        subject: { kind: 'merge_request', iid: 7, title: 'Add thing' },
        source: 'answer',
        status: 'open',
        askedAt: expect.any(Number),
        answeredAt: null
      }
    ])
    expect(listProjectEventQuestions(ctx, { ownerHostId: 'host-2' })).toEqual([])
    expect(listProjectEventQuestions(ctx, { ownerHostId: ctx.hostId, status: 'answered' })).toEqual(
      []
    )
  })
})
