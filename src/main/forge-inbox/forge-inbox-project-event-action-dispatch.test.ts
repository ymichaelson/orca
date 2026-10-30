import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { queueForgeItemRunOutcome } from './forge-inbox-ingest'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem,
  type ProjectEventActionClaim
} from './forge-inbox-project-event-action'
import {
  dispatchProjectEventAgent,
  PROJECT_EVENT_DISPATCH_RUN_REASON
} from './forge-inbox-project-event-action-dispatch'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import { answerProjectEventQuestion } from './forge-inbox-project-event-question-answer'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import type {
  ProjectEventAgentLaunchInput,
  ProjectEventAgentLaunchResult
} from './forge-inbox-project-event-agent-launch'
import { rowNumber } from './forge-inbox-rows'
import { bindForgeRunSession, transitionForgeRun } from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const REPO_ID = 'repo-1'
const MR_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)
const MR_NOTE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'note',
    project: { id: 3 },
    object_attributes: { id: 301, note: 'Please clarify', noteable_type: 'MergeRequest' },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' }
  })
)
const MR_PIPELINE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'pipeline',
    project: { id: 3 },
    object_attributes: { id: 1002, status: 'failed', sha: 'b'.repeat(40), ref: 'feature' },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened', target_project_id: 3 }
  })
)
const pushBody = (after: string) =>
  Buffer.from(
    JSON.stringify({
      object_kind: 'push',
      project: { id: 3 },
      ref: 'refs/heads/feature',
      before: 'a'.repeat(40),
      after
    })
  )
const OBSERVED_SHA = 'a'.repeat(40)

describe('project event action dispatch', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let ledger: ForgeInboxLedger
  let bindingId: string
  let clock: number

  function record(
    action: ProjectEventDecisionAction,
    body = MR_BODY,
    eventKind = 'Merge Request Hook'
  ): number {
    const deliveryId = admit(`delivery-${randomUUID()}`, body, eventKind)
    const decision = claimProjectEventDecision(ctx)
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    const result = decideProjectEventDelivery(ctx, deliveryId, decisionFor(action), decision)
    if (!result.ok) {
      throw new Error('fixture could not record the decision')
    }
    return deliveryId
  }

  function admit(dedupeKey: string, body: Buffer, eventKind: string): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind,
      dedupeKey,
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    return admitted.deliveryId
  }

  function claim(): ProjectEventActionClaim {
    const claimed = claimProjectEventAction(ctx, ['dispatch_agent'])
    if (!claimed) {
      throw new Error('expected a dispatch claim')
    }
    const linked = linkProjectEventDecisionItem(ctx, claimed)
    if (!linked.ok) {
      throw new Error(`fixture could not link the item: ${linked.reason}`)
    }
    return claimed
  }

  function observe(
    outcome: 'observed' | 'failed' | 'still-provisional' = 'observed'
  ): (claim: ProjectEventActionClaim) => Promise<ProjectEventHeadObservation> {
    return async () => {
      if (outcome === 'failed') {
        return { ok: false, code: 'network' }
      }
      if (outcome === 'still-provisional') {
        return observedHead({ versionToken: 'hook:sha-1', newRevision: false })
      }
      const head = ctx.db
        .prepare('SELECT id, current_revision FROM items ORDER BY id LIMIT 1')
        .get()
      if (!head) {
        throw new Error('expected the admitted item')
      }
      const itemId = rowNumber(head, 'id')
      const revision = rowNumber(head, 'current_revision') + 1
      ctx.db
        .prepare(
          `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
           VALUES (?, ?, 'sha256:observed', ?, ?)`
        )
        .run(itemId, revision, revision, ctx.now())
      ctx.db
        .prepare('UPDATE items SET current_revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, ctx.now(), itemId)
      return observedHead({ itemId, revision })
    }
  }

  function observedHead(
    overrides: Partial<Extract<ProjectEventHeadObservation, { ok: true }>> = {}
  ): ProjectEventHeadObservation {
    return {
      ok: true,
      itemId: 1,
      revision: 2,
      versionToken: 'sha256:observed',
      complete: true,
      newRevision: true,
      kind: 'merge_request',
      iid: 7,
      sha: OBSERVED_SHA,
      title: 'Add thing',
      state: 'opened',
      ...overrides
    }
  }

  function launches(): {
    calls: ProjectEventAgentLaunchInput[]
    launch: (input: ProjectEventAgentLaunchInput) => Promise<ProjectEventAgentLaunchResult>
  } {
    const calls: ProjectEventAgentLaunchInput[] = []
    return {
      calls,
      launch: async (input) => {
        calls.push(input)
        // The launcher owns session persistence; the dispatch only reads its verdict.
        bindForgeRunSession(ctx, input.runId, 'claude_session-1')
        return {
          ok: true,
          mode: 'structured',
          sessionId: 'claude_session-1',
          promptOutcome: 'journaled'
        }
      }
    }
  }

  function runs() {
    return ctx.db
      .prepare('SELECT id, state, reason, session_id, error, context_digest FROM runs ORDER BY id')
      .all()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-dispatch-action-'))
    clock = 1000
    store = fakeStore()
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
    ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), { secretStore: store })
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx, { repoId: REPO_ID, bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 0,
      patch: { enabled: true, agentId: 'claude', rules: 'rules' }
    })
  })

  afterEach(() => {
    if (!ledger.isClosed()) {
      ledger.close()
    }
    rmSync(root, { recursive: true, force: true })
  })

  async function seedAnsweredPreparation(answerNow = true) {
    const deliveryId = record('ask_user')
    const asked = claimProjectEventAction(ctx, ['ask_user'])
    if (!asked || !linkProjectEventDecisionItem(ctx, asked).ok) {
      throw new Error('expected an ask_user item')
    }
    await observe()(asked)
    const now = ctx.now()
    const inserted = ctx.db
      .prepare(`INSERT INTO runs (item_id, revision, state, generation, policy_generation,
        context_digest, analysis_kind, reason, created_at, updated_at)
        VALUES (1, 2, 'succeeded', 0, 1, 'sha256:observed', 'merge_request', ?, ?, ?)`)
      .run(PROJECT_EVENT_DISPATCH_RUN_REASON, now, now)
    const runId = Number(inserted.lastInsertRowid)
    ctx.db
      .prepare(`UPDATE project_event_decisions SET run_id = ?, action_state = 'blocked',
      action_token = NULL WHERE id = ?`)
      .run(runId, asked.decisionId)
    ctx.db
      .prepare(`UPDATE webhook_deliveries SET state = 'parked', parked_reason = 'awaiting-user'
      WHERE id = ?`)
      .run(deliveryId)
    const question = 'Should we release A or B?'
    const questionRow = ctx.db
      .prepare(`INSERT INTO project_event_questions
      (host_id, delivery_id, decision_id, item_id, question, status, asked_at)
      VALUES (?, ?, ?, 1, ?, 'open', ?)`)
      .run(ctx.hostId, deliveryId, asked.decisionId, question, now)
    const questionId = Number(questionRow.lastInsertRowid)
    if (answerNow) {
      const answered = answerProjectEventQuestion(ctx, {
        ownerHostId: ctx.hostId,
        questionId,
        answer: 'Release B'
      })
      if (!answered.ok) {
        throw new Error('expected the answer to reopen the delivery')
      }
    }
    return { deliveryId, runId, question, questionId }
  }

  it('does not open a generic question before the selected agent supplies proof', async () => {
    record('ask_user')
    const fake = launches()
    await drainProjectEventActions(ctx, {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(ctx.db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
  })

  it('dispatches one minimal preparation task for the first ask_user', async () => {
    record('ask_user')
    const fake = launches()
    await drainProjectEventActions(ctx, {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.prompt).toContain('rules')
    expect(fake.calls[0]?.prompt).toContain('Add thing')
    expect(ctx.db.prepare('SELECT run_id FROM project_event_decisions').get()).toEqual({
      run_id: 1
    })
  })

  it('provides the answered question and answer together to the next decision', async () => {
    const seeded = await seedAnsweredPreparation()
    const next = claimProjectEventDecision(ctx)
    if (!next) {
      throw new Error('expected an answered delivery to be claimable')
    }
    const context = JSON.stringify(next.input.context)
    expect(context).toContain(seeded.question)
    expect(context).toContain('Release B')
    expect(next.input.rules).toBe('rules')
  })

  it('dispatches distinct business work on the same head with the question and answer', async () => {
    const seeded = await seedAnsweredPreparation()
    const next = claimProjectEventDecision(ctx)
    if (
      !next ||
      !decideProjectEventDelivery(ctx, seeded.deliveryId, decisionFor('dispatch_agent'), next).ok
    ) {
      throw new Error('expected the answered delivery to be decided')
    }
    const fake = launches()
    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'done', runId: seeded.runId + 1 })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.prompt).toContain(seeded.question)
    expect(fake.calls[0]?.prompt).toContain('Release B')
    expect(runs().map((run) => run.context_digest)).toEqual(['sha256:observed', 'sha256:observed'])
  })

  it('claims ordinary work after answered business work on the same head', async () => {
    await seedAnsweredPreparation()
    const question = ctx.db.prepare('SELECT id FROM project_event_questions').get()
    if (!question) {
      throw new Error('expected the question')
    }
    const answered = queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON, {
      purpose: 'answered',
      questionId: rowNumber(question, 'id')
    })
    if (answered.kind !== 'queued') {
      throw new Error('expected an answered run')
    }
    expect(transitionForgeRun(ctx, answered.runId, { to: 'running' }).ok).toBe(true)
    expect(transitionForgeRun(ctx, answered.runId, { to: 'succeeded' }).ok).toBe(true)
    expect(queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON)).toEqual({
      kind: 'claimed'
    })
  })

  it('coalesces ordinary and answered business work directionally even at equal timestamps', async () => {
    ctx.now = () => 1234
    const seeded = await seedAnsweredPreparation(false)
    const firstId = seeded.questionId

    const ordinary = queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON)
    expect(ordinary.kind).toBe('queued')
    if (ordinary.kind !== 'queued') {
      throw new Error('expected an ordinary run')
    }
    expect(transitionForgeRun(ctx, ordinary.runId, { to: 'running' }).ok).toBe(true)
    expect(transitionForgeRun(ctx, ordinary.runId, { to: 'succeeded' }).ok).toBe(true)
    expect(
      answerProjectEventQuestion(ctx, {
        ownerHostId: ctx.hostId,
        questionId: firstId,
        answer: 'Release B'
      }).ok
    ).toBe(true)

    const answered = queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON, {
      purpose: 'answered',
      questionId: firstId
    })
    expect(answered.kind).toBe('queued')
    if (answered.kind !== 'queued') {
      throw new Error('expected an answered run')
    }
    expect(transitionForgeRun(ctx, answered.runId, { to: 'running' }).ok).toBe(true)
    expect(transitionForgeRun(ctx, answered.runId, { to: 'succeeded' }).ok).toBe(true)
    expect(queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON)).toEqual({
      kind: 'claimed'
    })
    expect(
      queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON, {
        purpose: 'answered',
        questionId: firstId
      })
    ).toEqual({ kind: 'claimed' })
    expect(
      ctx.db.prepare('SELECT id, origin_question_id, created_at FROM runs ORDER BY id').all()
    ).toEqual([
      { id: 1, origin_question_id: null, created_at: 1234 },
      { id: ordinary.runId, origin_question_id: null, created_at: 1234 },
      { id: answered.runId, origin_question_id: firstId, created_at: 1234 }
    ])

    const firstDecision = claimProjectEventDecision(ctx)
    if (
      !firstDecision ||
      !decideProjectEventDelivery(ctx, seeded.deliveryId, decisionFor('record_only'), firstDecision)
        .ok
    ) {
      throw new Error('expected the answered delivery to settle')
    }
    const secondDelivery = record('ask_user')
    const secondDecision = claimProjectEventAction(ctx, ['ask_user'])
    if (!secondDecision || !linkProjectEventDecisionItem(ctx, secondDecision).ok) {
      throw new Error('expected a second delivery and question decision')
    }
    const second = ctx.db
      .prepare(`INSERT INTO project_event_questions
      (host_id, delivery_id, decision_id, item_id, question, status, answer, asked_at, answered_at)
      VALUES (?, ?, ?, 1, 'Another question?', 'answered', 'Yes', 1234, 1234)`)
      .run(ctx.hostId, secondDelivery, secondDecision.decisionId)
    const secondId = Number(second.lastInsertRowid)
    expect(
      queueForgeItemRunOutcome(ctx, 1, PROJECT_EVENT_DISPATCH_RUN_REASON, {
        purpose: 'answered',
        questionId: secondId
      })
    ).toMatchObject({ kind: 'queued' })
  })

  it('observes the provisional head once, queues a run, and records the session', async () => {
    record('dispatch_agent')
    const fake = launches()

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'done', runId: 1 })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ itemId: 1, repoId: REPO_ID, runId: 1 })
    expect(fake.calls[0]?.prompt).toContain('Add thing')
    expect(runs()).toEqual([
      expect.objectContaining({
        id: 1,
        state: 'running',
        reason: PROJECT_EVENT_DISPATCH_RUN_REASON,
        session_id: 'claude_session-1',
        error: null,
        context_digest: 'sha256:observed'
      })
    ])
  })

  it('tells the agent which note triggered work on the merge request', async () => {
    record('dispatch_agent', MR_NOTE_BODY)
    const fake = launches()

    await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(fake.calls[0]?.prompt).toContain('"trigger":{"id":301,"kind":"note"}')
    expect(fake.calls[0]?.prompt).toContain('"kind":"merge_request"')
  })

  it('keeps the pipeline that fired the event when its merge request is the item', async () => {
    record('dispatch_agent', MR_PIPELINE_BODY, 'Pipeline Hook')
    const fake = launches()

    await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(fake.calls[0]?.prompt).toContain('"trigger":{"id":1002,"kind":"pipeline"}')
    expect(fake.calls[0]?.prompt).toContain('"kind":"merge_request"')
  })

  it('uses the current head when an older push is dispatched', async () => {
    record('dispatch_agent', pushBody('b'.repeat(40)), 'Push Hook')
    record('dispatch_agent', pushBody('c'.repeat(40)), 'Push Hook')
    const older = claim()
    claim()
    const fake = launches()

    expect(
      await dispatchProjectEventAgent(ctx, older, {
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({
      kind: 'done',
      runId: 1
    })
    expect(fake.calls[0]?.prompt).toContain('c'.repeat(40))
    expect(fake.calls[0]?.prompt).not.toContain('b'.repeat(40))
    expect(runs()).toHaveLength(1)
  })

  it('leaves a terminal dispatch without a session id', async () => {
    record('dispatch_agent')

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => async () => ({
        ok: true,
        mode: 'terminal',
        sessionId: null,
        promptOutcome: 'handed-to-terminal'
      }),
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'done', runId: 1 })
    expect(runs()).toEqual([expect.objectContaining({ state: 'running', session_id: null })])
  })

  it('blocks with the observation code and pays for nothing when the read fails', async () => {
    record('dispatch_agent')
    const fake = launches()

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe('failed'),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'blocked', code: 'network' })
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([])
  })

  it('refuses to run while the head is still provisional', async () => {
    record('dispatch_agent')
    const fake = launches()

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe('still-provisional'),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'blocked', code: 'dispatch-needs-observation' })
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([])
  })

  it('dispatches a head once and reports the repeat', async () => {
    record('dispatch_agent')
    record('dispatch_agent')
    const fake = launches()

    expect(
      await dispatchProjectEventAgent(ctx, claim(), {
        observeContext: observe(),
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({ kind: 'done', runId: 1 })
    expect(claimProjectEventAction(ctx, ['dispatch_agent'])).toBeNull()
    expect(transitionForgeRun(ctx, 1, { to: 'succeeded' }).ok).toBe(true)
    expect(
      await dispatchProjectEventAgent(ctx, claim(), {
        observeContext: observe('still-provisional'),
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({ kind: 'blocked', code: 'already-dispatched' })
    expect(fake.calls).toHaveLength(1)
    expect(runs()).toHaveLength(1)
  })

  it('fails the run when the launch reports a fixed code', async () => {
    record('dispatch_agent')

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => async () => ({ ok: false, code: 'dispatch-unconfigured' }),
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'blocked', code: 'dispatch-unconfigured' })
    expect(runs()).toEqual([
      expect.objectContaining({ state: 'failed', error: 'dispatch-unconfigured', session_id: null })
    ])
  })

  it.each(['policy-revoked', 'owner-stopped'])(
    'cancels, not fails, a run whose launch was stopped before it sent anything (%s)',
    async (code) => {
      record('dispatch_agent')

      const outcome = await dispatchProjectEventAgent(ctx, claim(), {
        observeContext: observe(),
        launchAgentFactory: () => async () => ({ ok: false, code }),
        launchAgentLedger: ledger
      })

      expect(outcome).toEqual({ kind: 'blocked', code })
      expect(runs()).toEqual([expect.objectContaining({ state: 'cancelled', error: code })])
    }
  )

  it('fails the run when the launch throws', async () => {
    record('dispatch_agent')

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => async () => {
        throw new Error('boom')
      },
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'blocked', code: 'dispatch-failed' })
    expect(runs()).toEqual([expect.objectContaining({ state: 'failed', error: 'dispatch-failed' })])
  })

  it('blocks when no launcher is wired', async () => {
    record('dispatch_agent')

    expect(await dispatchProjectEventAgent(ctx, claim(), {})).toEqual({
      kind: 'blocked',
      code: 'dispatch-unavailable'
    })
    expect(runs()).toEqual([])
  })

  it('abandons on abort without queueing a run', async () => {
    record('dispatch_agent')
    const abort = new AbortController()
    abort.abort()
    const fake = launches()

    expect(
      await dispatchProjectEventAgent(
        ctx,
        claim(),
        {
          observeContext: observe(),
          launchAgentFactory: () => fake.launch,
          launchAgentLedger: ledger
        },
        abort.signal
      )
    ).toBeNull()
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([])
  })

  it('fails the run when the prompt cannot be built', async () => {
    record('dispatch_agent')
    ctx.db
      .prepare('UPDATE project_bindings SET project_path = ? WHERE binding_id = ?')
      .run('p'.repeat(9000), bindingId)
    const fake = launches()

    const outcome = await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })

    expect(outcome).toEqual({ kind: 'blocked', code: 'dispatch-failed' })
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([
      expect.objectContaining({
        id: 1,
        state: 'failed',
        error: 'dispatch-failed',
        session_id: null
      })
    ])
  })

  it('puts the policy rules in the prompt and fences the launch to its generation', async () => {
    record('dispatch_agent')
    const fake = launches()
    await dispatchProjectEventAgent(ctx, claim(), {
      observeContext: observe(),
      launchAgentFactory: () => fake.launch,
      launchAgentLedger: ledger
    })
    const [call] = fake.calls
    expect(call?.prompt).toContain('<project-rules>\nrules\n</project-rules>')
    expect(call?.prompt.indexOf('<project-rules>')).toBeLessThan(
      call?.prompt.indexOf('<event-data>') ?? 0
    )
    expect(call?.policyGeneration).toBe(1)
  })

  it('blocks before queueing a run when the policy is disabled', async () => {
    record('dispatch_agent')
    const claimed = claim()
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })
    const fake = launches()
    expect(
      await dispatchProjectEventAgent(ctx, claimed, {
        observeContext: observe(),
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({ kind: 'blocked', code: 'dispatch-unconfigured' })
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([])
  })

  it('blocks when the policy moved since the decision was made', async () => {
    record('dispatch_agent')
    const claimed = claim()
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { agentId: 'codex' }
    })
    const fake = launches()
    expect(
      await dispatchProjectEventAgent(ctx, claimed, {
        observeContext: observe(),
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({ kind: 'blocked', code: 'dispatch-unconfigured' })
    expect(fake.calls).toEqual([])
    expect(runs()).toEqual([])
  })

  it('blocks when the repo is not the one linked to the item binding', async () => {
    record('dispatch_agent')
    const claimed = { ...claim(), repoId: 'repo-other' }
    const fake = launches()
    expect(
      await dispatchProjectEventAgent(ctx, claimed, {
        observeContext: observe(),
        launchAgentFactory: () => fake.launch,
        launchAgentLedger: ledger
      })
    ).toEqual({ kind: 'blocked', code: 'dispatch-unconfigured' })
    expect(fake.calls).toEqual([])
  })
})

function decisionFor(action: ProjectEventDecisionAction) {
  return {
    ok: true as const,
    provider: 'jev' as const,
    model: 'jev-1',
    action,
    confidence: 0.8,
    probabilities: {
      record_only: 0.04,
      notify: 0.04,
      wait: 0.04,
      fetch_context: 0.04,
      dispatch_agent: 0.8,
      ask_user: 0.04
    },
    usage: { inputTokens: 10, outputTokens: 2 }
  }
}
