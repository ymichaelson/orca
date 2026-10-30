import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES } from '../../shared/forge-inbox-project-event-question'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import { readForgeItemTimeline } from './forge-inbox-item-timeline'
import { getForgeItemDetail } from './forge-inbox-queries'
import { projectForgeItemDetail } from './forge-inbox-read-projection'
import { answerProjectEventQuestion } from './forge-inbox-project-event-question-answer'
import {
  openQuestionPreparationHarness,
  PREPARED_QUESTION
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  openProjectEventQuestionFixture,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  type ProjectEventQuestionFixture
} from './forge-inbox-project-event-question-test-kit'
import { rowNumber } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

describe('Inbox item timeline', () => {
  let fixture: ProjectEventQuestionFixture
  let ctx: ForgeLedgerContext

  beforeEach(() => {
    fixture = openProjectEventQuestionFixture('forge-item-timeline-')
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

  async function askUser(): Promise<{ itemId: number; questionId: number }> {
    decide('ask_user')
    const harness = openQuestionPreparationHarness(fixture.ledger)
    try {
      expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
      await harness.complete()
    } finally {
      harness.dispose()
    }
    const row = ctx.db.prepare('SELECT id, item_id FROM project_event_questions').get()
    if (!row) {
      throw new Error('expected an open question')
    }
    return { itemId: rowNumber(row, 'item_id'), questionId: rowNumber(row, 'id') }
  }

  it('merges the event, the decision and the question of one item', async () => {
    const { itemId } = await askUser()

    const timeline = readForgeItemTimeline(ctx, itemId)

    expect(timeline.map((entry) => entry.kind).sort()).toEqual([
      'decision',
      'event',
      'question',
      'run'
    ])
    expect(new Set(timeline.map((entry) => entry.id)).size).toBe(timeline.length)
    const question = timeline.find((entry) => entry.kind === 'question')
    // The item the question is about travels with it, so a client renders the reference itself.
    expect(question?.kind === 'question' ? question.subject : null).toEqual({
      kind: 'merge_request',
      iid: 7,
      title: 'Add thing'
    })
    expect(question?.kind === 'question' ? question.question : null).toBe(PREPARED_QUESTION)
    // A task's own question is shown as asked, so the entry says who wrote it.
    expect(question?.kind === 'question' ? question.source : null).toBe('answer')
    const run = timeline.find((entry) => entry.kind === 'run')
    expect(run?.kind === 'run' ? run.state : null).toBe('succeeded')
    expect(timeline.every((entry) => Number.isSafeInteger(entry.at))).toBe(true)
  })

  it('orders entries newest first by each row own timestamp', async () => {
    const { itemId } = await askUser()
    ctx.db.prepare('UPDATE events SET received_at = 1000').run()
    ctx.db.prepare('UPDATE project_event_decisions SET decided_at = 2000').run()
    ctx.db.prepare('UPDATE project_event_questions SET asked_at = 3000').run()

    const timeline = readForgeItemTimeline(ctx, itemId)

    expect(timeline.map((entry) => entry.kind)).toEqual(['question', 'decision', 'run', 'event'])
    // The preparation run is stamped by the real clock, so only its place below both pinned rows is fixed.
    expect(timeline.slice(0, 2).map((entry) => entry.at)).toEqual([3000, 2000])
    expect(
      timeline
        .slice(2)
        .map((entry) => entry.kind)
        .sort()
    ).toEqual(['event', 'run'])
    expect(timeline[3].kind === 'event' ? timeline[3].eventKind : null).toBe('Merge Request Hook')
  })

  it('adds the answer as its own entry once the user replies', async () => {
    const { itemId, questionId } = await askUser()
    ctx.db.prepare('UPDATE project_event_questions SET asked_at = 1000').run()

    const answered = answerProjectEventQuestion(ctx, {
      ownerHostId: ctx.hostId,
      questionId,
      answer: 'keep going'
    })
    if (!answered.ok) {
      throw new Error(`fixture could not answer: ${answered.reason}`)
    }
    ctx.db.prepare('UPDATE project_event_questions SET answered_at = 4000').run()

    const timeline = readForgeItemTimeline(ctx, itemId)

    expect(timeline.filter((entry) => entry.kind === 'question')).toHaveLength(1)
    const answer = timeline.find((entry) => entry.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer : null).toEqual({
      kind: 'answer',
      id: `answer:${questionId}`,
      at: 4000,
      questionId,
      answer: 'keep going'
    })
    expect(timeline[0].kind).toBe('answer')
  })

  it.each([
    ['ASCII', 'a'.repeat(2100), 'a'.repeat(2000)],
    ['CJK', '界'.repeat(2000), '界'.repeat(666)],
    ['partial emoji', `${'a'.repeat(1999)}😀`, 'a'.repeat(1999)],
    ['exact-fit emoji', `${'a'.repeat(1996)}😀TAIL`, `${'a'.repeat(1996)}😀`]
  ])('bounds a stored %s answer to whole UTF-8 characters', async (_name, stored, expected) => {
    const { itemId, questionId } = await askUser()
    ctx.db
      .prepare(
        "UPDATE project_event_questions SET status = 'answered', answered_at = 1, answer = ? WHERE id = ?"
      )
      .run(stored, questionId)

    const answer = readForgeItemTimeline(ctx, itemId).find((entry) => entry.kind === 'answer')
    expect(answer?.kind).toBe('answer')
    if (answer?.kind !== 'answer' || answer.answer === undefined) {
      throw new Error('expected a stored answer in the timeline')
    }
    expect(Buffer.byteLength(answer.answer, 'utf8')).toBeLessThanOrEqual(
      FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES
    )
    expect(answer.answer).toBe(expected)
  })

  it('keeps a superseded decision, flagged, with its own action state', async () => {
    const { itemId } = await askUser()
    ctx.db.prepare('UPDATE project_event_decisions SET superseded = 1').run()

    const decision = readForgeItemTimeline(ctx, itemId).find((entry) => entry.kind === 'decision')

    expect(decision).toMatchObject({ kind: 'decision', action: 'ask_user', superseded: true })
    expect(decision?.kind === 'decision' ? decision.state : '').toMatch(/^[a-z-]+$/)
  })

  it('shows an agent run in the same stream and scopes to one item', async () => {
    const { itemId } = await askUser()
    ctx.db
      .prepare(`INSERT INTO runs (item_id, revision, state, policy_generation, context_digest,
        analysis_kind, reason, created_at, updated_at)
        VALUES (?, 1, 'succeeded', 1, 'digest', 'merge_request', 'review-requested', 5000, 6000)`)
      .run(itemId)
    const other = ingestForgeEventInTransaction(ctx, {
      hostId: ctx.hostId,
      instanceId: 'inst-1',
      projectId: 'project-1',
      kind: 'issue',
      iid: 9,
      dedupeKey: 'dedupe-9',
      eventKind: 'Issue Hook',
      versionToken: 'sha-9',
      sourceOrder: 1,
      payload: {}
    })
    if (other.duplicate) {
      throw new Error('fixture expected a first delivery')
    }

    const timeline = readForgeItemTimeline(ctx, itemId)
    const run = timeline.find((entry) => entry.kind === 'run')
    expect(run?.kind === 'run' ? { state: run.state, at: run.at } : null).toEqual({
      state: 'succeeded',
      at: 6000
    })
    expect(
      timeline.every((entry) => entry.kind !== 'event' || entry.eventKind !== 'Issue Hook')
    ).toBe(true)

    const otherTimeline = readForgeItemTimeline(ctx, other.itemId)
    expect(otherTimeline.map((entry) => entry.kind)).toEqual(['event'])
  })

  it('surfaces the stream with its content through the item detail read', async () => {
    const { itemId } = await askUser()

    const detail = getForgeItemDetail(ctx, SCOPE, itemId, 'client-1')

    expect(detail?.timeline.map((entry) => entry.kind).sort()).toEqual([
      'decision',
      'event',
      'question',
      'run'
    ])
  })

  function insertRun(
    itemId: number,
    reason: string,
    error: string | null,
    updatedAt: number
  ): void {
    ctx.db
      .prepare(`INSERT INTO runs (item_id, revision, state, policy_generation, context_digest,
        analysis_kind, reason, error, created_at, updated_at)
        VALUES (?, 1, 'failed', 1, 'digest', 'merge_request', ?, ?, 5000, ?)`)
      .run(itemId, reason, error, updatedAt)
  }

  it('clamps a zero or non-finite limit instead of widening the page', async () => {
    const { itemId } = await askUser()

    expect(readForgeItemTimeline(ctx, itemId, 0)).toHaveLength(1)
    expect(readForgeItemTimeline(ctx, itemId, -5)).toHaveLength(1)
    expect(readForgeItemTimeline(ctx, itemId, Number.NaN).length).toBe(4)
  })

  it('projects dispatch run reasons and error codes the same way for runs and timeline', async () => {
    const { itemId } = await askUser()
    insertRun(itemId, 'project-event-dispatch', 'workspace-ambiguous', 7000)
    insertRun(itemId, 'untrusted-backend-text', 'free text from a backend', 8000)

    const detail = getForgeItemDetail(ctx, SCOPE, itemId, 'client-1')
    if (!detail) {
      throw new Error('expected item detail')
    }
    const view = projectForgeItemDetail(detail)

    expect(view.runs.map((run) => ({ reason: run.reason, errorCode: run.errorCode }))).toEqual(
      expect.arrayContaining([
        { reason: 'project-event-dispatch', errorCode: 'workspace-ambiguous' },
        { reason: null, errorCode: 'unknown' }
      ])
    )
    const timelineReasons = (view.timeline ?? []).flatMap((entry) =>
      entry.kind === 'run' ? [entry.reason] : []
    )
    expect(timelineReasons.sort()).toEqual([
      null,
      'project-event-dispatch',
      'project-event-dispatch'
    ])
  })
})
