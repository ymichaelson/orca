import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { ingestForgeEventInTransaction, queueForgeItemRunOutcome } from './forge-inbox-ingest'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  markQuestionPreparationUnproven,
  settleQuestionPreparation
} from './forge-inbox-project-event-question-preparation'
import { emptyProbe, launchPorts } from './forge-inbox-project-event-agent-launch-test-kit'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import type { ProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import type { ProjectEventRunWatchOptions } from './forge-inbox-project-event-run-watch'
import {
  observeItemHead,
  openProofFeed,
  openQuestionPreparationHarness,
  PREPARED_QUESTION,
  questionProofText,
  type QuestionPreparationHarness
} from './forge-inbox-project-event-question-preparation-test-kit'
import {
  PROJECT_EVENT_TEST_REPO_ID,
  projectEventQuestionBody,
  projectEventQuestionDecision,
  seedProjectEventQuestionPolicy
} from './forge-inbox-project-event-question-test-kit'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { rowNumber } from './forge-inbox-rows'
import {
  applyTransition,
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const LATE_QUESTION = 'Should we release C?'

async function waitForState(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('project event question preparation lifecycle', () => {
  let root: string
  let ledger: ForgeInboxLedger
  let ctx: ForgeLedgerContext
  let bindingId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-question-preparation-'))
    let clock = 1000
    ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
      hostId: 'host-1',
      now: () => ++clock,
      secretStore: fakeStore()
    })
    ctx = ledger.ledgerContext()
    bindingId = seedProjectEventQuestionPolicy(ctx)
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  function askDelivery(): number {
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
    const decision = claimProjectEventDecision(ctx)
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    if (
      !decideProjectEventDelivery(
        ctx,
        admitted.deliveryId,
        projectEventQuestionDecision('ask_user'),
        decision
      ).ok
    ) {
      throw new Error('fixture could not record the ask_user decision')
    }
    return admitted.deliveryId
  }

  function runRow(runId: number) {
    const row = ctx.db
      .prepare(
        `SELECT state, error, session_id, dispatch_client_message_id, cancel_requested_at
         FROM runs WHERE id = ?`
      )
      .get(runId)
    if (!row) {
      throw new Error(`expected run ${runId}`)
    }
    return row
  }

  function deliveryRow(deliveryId: number) {
    const row = ctx.db
      .prepare(
        'SELECT state, decision_state, parked_reason, last_error_code FROM webhook_deliveries WHERE id = ?'
      )
      .get(deliveryId)
    if (!row) {
      throw new Error(`expected delivery ${deliveryId}`)
    }
    return row
  }

  function questions() {
    return ctx.db.prepare('SELECT question, subject_kind FROM project_event_questions').all()
  }

  function preparedProof(question = 'Release A or B?'): ForgeProtectedTurnProof {
    return {
      turnId: 'turn-1',
      terminal: true,
      outcome: 'success',
      text: questionProofText(question)
    }
  }

  async function drainPrepared(harness: QuestionPreparationHarness): Promise<number> {
    askDelivery()
    const drained = await harness.drain()
    expect(drained).toMatchObject({ executed: 1, failed: 0 })
    expect(harness.probe.delivered).toHaveLength(1)
    return harness.runId()
  }

  function startOrdinaryRun(iid: number): number {
    const ingested = ingestForgeEventInTransaction(ctx, {
      hostId: ctx.hostId,
      instanceId: 'inst-1',
      projectId: 'project-1',
      kind: 'merge_request',
      iid,
      dedupeKey: `dedupe-${iid}`,
      eventKind: 'Merge Request Hook',
      versionToken: `sha-${iid}`,
      sourceOrder: iid,
      payload: {}
    })
    if (ingested.duplicate) {
      throw new Error('fixture expected a first delivery')
    }
    const queued = queueForgeItemRunOutcome(ctx, ingested.itemId, 'review-requested')
    const run = queued.kind === 'queued' ? readForgeRun(ctx, queued.runId) : null
    if (
      !run ||
      !applyTransition(ctx, run, { to: 'running' }).ok ||
      !bindSessionAndTurn(ctx, run.id, iid)
    ) {
      throw new Error('fixture could not start the ordinary run')
    }
    return run.id
  }

  function bindSessionAndTurn(context: ForgeLedgerContext, runId: number, iid: number): boolean {
    return (
      bindForgeRunSession(context, runId, `structured-ordinary-${iid}`) &&
      bindForgeRunDispatchTurn(context, runId, `ordinary-send-${iid}`)
    )
  }

  /** The launch production runs for the first preparation, seen through its run watch. */
  function productionLaunch(): {
    launch: ProjectEventAgentLaunch
    requests: ProjectEventRunWatchOptions[]
  } {
    const requests: ProjectEventRunWatchOptions[] = []
    const launch = createForgeProjectEventAgentLaunch(ledger, {
      ...launchPorts(emptyProbe()),
      createStructuredSession: async (args) => ({
        ok: true,
        value: { sessionId: args.envelope.sessionId, fence: 4, tabId: 'tab-1' }
      }),
      deliverStructuredPrompt: async (args) => args.clientMessageId,
      runWatch: {
        watch: (_sessionId, _runId, _send, options) => {
          requests.push(options ?? {})
        },
        dispose: () => {},
        isDisposed: () => false
      }
    })
    return { launch, requests }
  }

  it.each(['running', 'unverifiable'] as const)(
    'leaves an ordinary run that is %s alone when its preparation bound runs out of proof',
    async (state) => {
      const runId = startOrdinaryRun(9101)
      if (
        state === 'unverifiable' &&
        !transitionForgeRun(ctx, runId, { to: 'unverifiable', error: 'unknown-outcome' }).ok
      ) {
        throw new Error('fixture could not make the ordinary run unverifiable')
      }

      expect(markQuestionPreparationUnproven(ctx, runId)).toBe(false)

      const expected =
        state === 'running'
          ? { state: 'running', error: null }
          : { state: 'unverifiable', error: 'unknown-outcome' }
      expect(runRow(runId)).toMatchObject(expected)
      expect(
        ctx.db
          .prepare('SELECT session_id, dispatch_client_message_id FROM runs WHERE id = ?')
          .get(runId)
      ).toEqual({
        session_id: `structured-ordinary-9101`,
        dispatch_client_message_id: 'ordinary-send-9101'
      })
    }
  )

  function occupyDispatchSlots(): number[] {
    const runIds: number[] = []
    for (const iid of [9001, 9002]) {
      const ingested = ingestForgeEventInTransaction(ctx, {
        hostId: ctx.hostId,
        instanceId: 'inst-1',
        projectId: 'project-1',
        kind: 'merge_request',
        iid,
        dedupeKey: `dedupe-${iid}`,
        eventKind: 'Merge Request Hook',
        versionToken: `sha-${iid}`,
        sourceOrder: iid,
        payload: {}
      })
      if (ingested.duplicate) {
        throw new Error('fixture expected a first delivery')
      }
      const queued = queueForgeItemRunOutcome(ctx, ingested.itemId, 'review-requested')
      if (queued.kind !== 'queued') {
        throw new Error(`fixture could not queue an occupying run: ${queued.kind}`)
      }
      const run = readForgeRun(ctx, queued.runId)
      if (!run || !applyTransition(ctx, run, { to: 'running' }).ok) {
        throw new Error('fixture could not start the occupying run')
      }
      runIds.push(queued.runId)
    }
    return runIds
  }

  it('stays queued without a slot and launches its preparation once a later drain finds one', async () => {
    const harness = openQuestionPreparationHarness(ledger)
    const occupied = occupyDispatchSlots()
    askDelivery()

    expect(await harness.drain()).toMatchObject({ executed: 0, failed: 0 })
    expect(harness.probe.terminal).toEqual([])
    expect(harness.probe.delivered).toEqual([])
    expect(deliveryRow(1)).toMatchObject({
      state: 'pending',
      decision_state: 'decided',
      parked_reason: null
    })

    const released = readForgeRun(ctx, occupied[0])
    if (!released) {
      throw new Error('expected the occupying run')
    }
    expect(applyTransition(ctx, released, { to: 'succeeded' }).ok).toBe(true)

    // The next drain owes the delivery that one task, and it is the only thing it takes.
    expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
    expect(harness.probe.delivered).toHaveLength(1)
    expect(deliveryRow(1)).toMatchObject({
      state: 'parked',
      parked_reason: 'preparing-question'
    })
    expect(ctx.db.prepare('SELECT last_error_code FROM project_event_decisions').get()).toEqual({
      last_error_code: 'preparing-question'
    })
    expect(runRow(harness.runId()).state).toBe('running')
    expect(harness.probe.delivered[0].text).toContain('preparing one specific question')

    await harness.complete()
    await waitForState(() => questions().length === 1, 'the prepared question')
    expect(questions()).toEqual([{ question: PREPARED_QUESTION, subject_kind: 'merge_request' }])

    expect(await harness.drain()).toMatchObject({ executed: 0, failed: 0 })
    expect(harness.probe.delivered).toHaveLength(1)
    harness.dispose()
  })

  it('dispatches the minimal task a preparation declined, then hands over the question it found', async () => {
    const harness = openQuestionPreparationHarness(ledger)
    const runId = await drainPrepared(harness)

    harness.setProofText('```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```')
    await harness.complete()

    expect(
      ctx.db.prepare('SELECT action_state, last_error_code FROM project_event_decisions').get()
    ).toEqual({ action_state: 'queued', last_error_code: 'preparing-question' })
    expect(runRow(runId)).toMatchObject({ state: 'succeeded', error: null })
    expect(ctx.db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
    expect(deliveryRow(1)).toMatchObject({ state: 'parked', parked_reason: 'preparing-question' })

    expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
    expect(harness.probe.delivered).toHaveLength(2)
    const escalatedRunId = harness.runId()
    expect(escalatedRunId).toBeGreaterThan(runId)
    // No question exists yet, so the task is not an answer to one.
    expect(
      ctx.db.prepare('SELECT origin_question_id FROM runs WHERE id = ?').get(escalatedRunId)
    ).toEqual({ origin_question_id: null })
    expect(harness.probe.delivered[1].text).toContain('ask the minimum question')
    expect(harness.probe.delivered[1].text).toContain('orca-question')

    harness.setProofText(questionProofText('Merge before the release?'))
    await harness.complete()
    await waitForState(
      () => ctx.db.prepare('SELECT question FROM project_event_questions').all().length === 1,
      'the escalated question'
    )

    expect(
      ctx.db.prepare('SELECT question, source, subject_kind FROM project_event_questions').all()
    ).toEqual([
      { question: 'Merge before the release?', source: 'answer', subject_kind: 'merge_request' }
    ])
    expect(deliveryRow(1)).toMatchObject({ state: 'parked', parked_reason: 'awaiting-user' })
    harness.dispose()
  })

  it('asks the person itself when the one follow-up task declines as well', async () => {
    const harness = openQuestionPreparationHarness(ledger, {
      proofText: '```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```'
    })
    const runId = await drainPrepared(harness)

    await harness.complete()
    // The decline is not a dead end: the delivery owes exactly one minimum task.
    expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })
    expect(harness.probe.delivered).toHaveLength(2)

    await harness.complete()
    await waitForState(() => questions().length === 1, 'the exhausted question')

    expect(runRow(runId)).toMatchObject({ state: 'succeeded', error: null })
    expect(
      ctx.db.prepare('SELECT question, source, subject_kind FROM project_event_questions').all()
    ).toEqual([
      {
        question: '需要你确认：是否要由你直接决定接下来怎么处理这个事件？',
        source: 'exhausted',
        subject_kind: 'merge_request'
      }
    ])
    expect(deliveryRow(1)).toMatchObject({ state: 'parked', parked_reason: 'awaiting-user' })
    harness.dispose()
  })

  it('asks the person itself when the owed task cannot be started at all', async () => {
    const harness = openQuestionPreparationHarness(ledger, {
      proofText: '```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```'
    })
    await drainPrepared(harness)
    await harness.complete()

    harness.setRefusal({ code: 'structured_agent_session_unsupported', message: 'no chat here' })
    expect(await harness.drain()).toMatchObject({ executed: 1, failed: 0 })

    // A task that never started is still a decline: the person is asked rather than left waiting.
    expect(
      ctx.db.prepare('SELECT question, source, subject_kind FROM project_event_questions').all()
    ).toEqual([
      {
        question: '需要你确认：是否要由你直接决定接下来怎么处理这个事件？',
        source: 'exhausted',
        subject_kind: 'merge_request'
      }
    ])
    expect(deliveryRow(1)).toMatchObject({ state: 'parked', parked_reason: 'awaiting-user' })
    harness.dispose()
  })

  it('lets a later preparation on one session own its turn without taking the first one', async () => {
    const preparation = productionLaunch()
    askDelivery()
    askDelivery()
    const firstDrain = await drainProjectEventActions(ctx, {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      observeContext: observeItemHead(ctx),
      launchAgentFactory: () => preparation.launch,
      launchAgentLedger: ledger
    })
    const launched = ctx.db
      .prepare('SELECT id, session_id FROM runs ORDER BY id DESC LIMIT 1')
      .get()
    const firstRequest = preparation.requests[0]
    if (
      firstDrain.executed !== 1 ||
      !launched ||
      firstRequest === undefined ||
      typeof launched.session_id !== 'string'
    ) {
      throw new Error('fixture expected a first preparation send')
    }
    const first = rowNumber(launched, 'id')
    const sessionId = String(launched.session_id)
    // Another run on the same session registered after the preparation owns its turn.
    const otherSend = 'ordinary-send-9301'
    const other = startOrdinaryRun(9301)
    ctx.db
      .prepare('UPDATE runs SET session_id = ?, dispatch_client_message_id = ? WHERE id = ?')
      .run(sessionId, otherSend, other)
    const feed = openProofFeed(
      ledger,
      async (_session, id) =>
        id === otherSend
          ? {
              turnId: 'turn-other',
              terminal: true,
              outcome: 'success',
              text: questionProofText(LATE_QUESTION)
            }
          : null,
      5
    )

    feed.watch.watch(sessionId, other, otherSend)
    feed.watch.watch(sessionId, first, 'the-first-prep-send', firstRequest)
    await feed.complete(sessionId, 'success')
    expect(questions()).toEqual([])
    expect(runRow(other)).toMatchObject({ state: 'running', error: null })
    expect(runRow(first)).toMatchObject({ state: 'running' })
    feed.watch.dispose()
  })

  it('leaves a preparation unverifiable and its delivery parked when the turn proof never arrives', async () => {
    const harness = openQuestionPreparationHarness(ledger, {
      proofText: null,
      retryDelayMs: 1
    })
    const runId = await drainPrepared(harness)

    await harness.complete()
    await waitForState(
      () => runRow(runId).state === 'unverifiable',
      'the unprovable preparation to become unverifiable'
    )

    expect(runRow(runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome',
      session_id: harness.sessionId(),
      dispatch_client_message_id: harness.clientMessageId()
    })
    expect(deliveryRow(1)).toMatchObject({
      state: 'parked',
      parked_reason: 'preparing-question'
    })
    expect(questions()).toEqual([])
    expect(harness.probe.delivered).toHaveLength(1)
    harness.dispose()
  })

  it('settles a late exact proof once and publishes its question, then changes nothing', async () => {
    const harness = openQuestionPreparationHarness(ledger, { proofText: null })
    const runId = await drainPrepared(harness)
    if (!transitionForgeRun(ctx, runId, { to: 'unverifiable', error: 'unknown-outcome' }).ok) {
      throw new Error('fixture could not mark the preparation unverifiable')
    }
    const sessionId = harness.sessionId()
    const clientMessageId = harness.clientMessageId()
    if (sessionId === null || clientMessageId === null) {
      throw new Error('expected the preparation turn identity')
    }
    const question = 'Release A or B?'
    harness.setProofText(questionProofText(question))
    await harness.complete()

    expect(questions()).toEqual([{ question, subject_kind: 'merge_request' }])
    expect(runRow(runId)).toMatchObject({ state: 'succeeded', error: null })
    expect(deliveryRow(1)).toMatchObject({
      state: 'parked',
      parked_reason: 'awaiting-user'
    })
    const askedAt = ctx.db.prepare('SELECT id, asked_at FROM project_event_questions').get()
    expect(askedAt).toBeTruthy()

    expect(
      settleQuestionPreparation(ctx, runId, sessionId, clientMessageId, preparedProof(question))
    ).toBe(true)
    expect(questions()).toEqual([{ question, subject_kind: 'merge_request' }])
    expect(ctx.db.prepare('SELECT id, asked_at FROM project_event_questions').get()).toEqual(
      askedAt
    )
    harness.dispose()
  })

  it('ignores a proof whose session id or client message id is not this run', async () => {
    const harness = openQuestionPreparationHarness(ledger)
    const runId = await drainPrepared(harness)
    const sessionId = harness.sessionId()
    const clientMessageId = harness.clientMessageId()
    if (sessionId === null || clientMessageId === null) {
      throw new Error('expected the preparation turn identity')
    }

    expect(
      settleQuestionPreparation(ctx, runId, 'another-session', clientMessageId, preparedProof())
    ).toBe(true)
    expect(
      settleQuestionPreparation(ctx, runId, sessionId, 'another-message', preparedProof())
    ).toBe(true)

    expect(questions()).toEqual([])
    expect(runRow(runId)).toMatchObject({
      state: 'running',
      session_id: sessionId,
      dispatch_client_message_id: clientMessageId
    })
    expect(deliveryRow(1)).toMatchObject({
      state: 'parked',
      parked_reason: 'preparing-question'
    })
    harness.dispose()
  })

  it.each([
    ['revoked', 'policy-disabled'],
    ['head-moved', 'head-moved']
  ] as const)(
    'fails a %s preparation closed instead of leaving its delivery parked',
    async (change, code) => {
      const harness = openQuestionPreparationHarness(ledger)
      const runId = await drainPrepared(harness)

      if (change === 'revoked') {
        expect(
          updateProjectEventPolicy(ctx, {
            repoId: PROJECT_EVENT_TEST_REPO_ID,
            expectedGeneration: 1,
            patch: { enabled: false }
          })
        ).toMatchObject({ ok: true })
      } else {
        const current = ctx.db.prepare('SELECT current_revision FROM items WHERE id = 1').get()
        if (!current) {
          throw new Error('expected the prepared item')
        }
        const revision = rowNumber(current, 'current_revision') + 1
        ctx.db
          .prepare(
            `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
             VALUES (1, ?, 'sha256:new-head', ?, ?)`
          )
          .run(revision, revision, ctx.now())
        ctx.db
          .prepare('UPDATE items SET current_revision = ?, head_order = ? WHERE id = 1')
          .run(revision, revision)
      }

      await harness.complete()

      expect(questions()).toEqual([])
      expect(runRow(runId).state).toBe('failed')
      expect(deliveryRow(1)).toMatchObject({
        state: 'failed',
        last_error_code: code,
        parked_reason: null
      })
      harness.dispose()
    }
  )

  it('refuses the structured-only preparation without creating a terminal or sending', async () => {
    const harness = openQuestionPreparationHarness(ledger, {
      refusal: { code: 'structured_agent_session_unsupported', message: 'no chat here' }
    })
    askDelivery()

    const drained = await harness.drain()

    expect(drained).toMatchObject({ executed: 1, failed: 0 })
    expect(harness.probe.terminal).toEqual([])
    expect(harness.probe.delivered).toEqual([])
    expect(questions()).toEqual([])
    expect(runRow(1)).toMatchObject({
      state: 'failed',
      error: 'structured-agent-session-unsupported'
    })
    expect(deliveryRow(1)).toMatchObject({
      state: 'failed',
      last_error_code: 'structured-agent-session-unsupported'
    })
    harness.dispose()
  })

  it.each([
    ['not JSON', 'not JSON'],
    [
      'an extra key',
      '```orca-question\n{"v":1,"kind":"question","question":"a","answer":"b"}\n```'
    ],
    ['an empty question', '```orca-question\n{"v":1,"kind":"question","question":"  "}\n```'],
    [
      'an oversized question',
      `\`\`\`orca-question\n{"v":1,"kind":"question","question":${JSON.stringify('x'.repeat(4001))}}\n\`\`\``
    ],
    [
      'a non-well-formed question',
      '```orca-question\n{"v":1,"kind":"question","question":"\\ud800"}\n```'
    ],
    [
      'two fenced blocks',
      '```orca-question\n{"v":1,"kind":"question","question":"a"}\n```\n```orca-question\n{"v":1,"kind":"question","question":"b"}\n```'
    ]
  ])('publishes nothing for %s output and fails the preparation visibly', async (_name, text) => {
    const harness = openQuestionPreparationHarness(ledger, { proofText: text })
    const runId = await drainPrepared(harness)

    await harness.complete()

    expect(questions()).toEqual([])
    expect(runRow(runId)).toMatchObject({ state: 'failed', error: 'dispatch-unverifiable' })
    expect(deliveryRow(1)).toMatchObject({
      state: 'failed',
      last_error_code: 'dispatch-unverifiable',
      parked_reason: null
    })
    harness.dispose()
  })
})
