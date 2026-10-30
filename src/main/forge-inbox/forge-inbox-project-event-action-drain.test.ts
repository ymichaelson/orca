import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ProjectEventDecisionAction,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ingestForgeEvent } from './forge-inbox-ingest'
import { claimForgeNotifications } from './forge-inbox-notification-claim'
import { createForgeCandidateReader } from './forge-inbox-notification-candidates'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  claimProjectEventAction,
  getProjectEventActionSchedule,
  PROJECT_EVENT_WIRED_ACTIONS,
  recoverInterruptedProjectEventActions,
  type ProjectEventActionClaim
} from './forge-inbox-project-event-action'
import {
  drainProjectEventActions,
  projectEventWaitReason
} from './forge-inbox-project-event-action-drain'
import { projectEventNotificationCategory } from './forge-inbox-project-event-notification'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { projectEventSubject } from './forge-inbox-project-event-subject'
import { changeFromRow, isRecord, rowNumber, rowText } from './forge-inbox-rows'
import {
  PROJECT_EVENT_TEST_REPO_ID,
  seedProjectEventQuestionPolicy
} from './forge-inbox-project-event-question-test-kit'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const RULES = '合并请求需要评审。'
const MR_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: {
      iid: 7,
      title: 'Add thing',
      state: 'opened',
      source_branch: 'feat',
      target_branch: 'main'
    },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)
const MR_NEXT_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: {
      iid: 7,
      title: 'Add thing',
      state: 'opened',
      source_branch: 'feat',
      target_branch: 'main'
    },
    object_attributes: { action: 'update', last_commit: { id: 'sha-2' } }
  })
)
const PIPELINE_RUNNING_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'pipeline',
    project: { id: 3 },
    object_attributes: { id: 11, status: 'running', ref: 'main', sha: 'sha-2' }
  })
)
const NO_IID_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { title: 'missing' }
  })
)
const CONTEXT_ROUND_ONE_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } },
    context_round: 1
  })
)
const OBSERVED_SHA = 'a'.repeat(40)

const decision = (action: ProjectEventDecisionAction): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action,
  confidence: 0.8,
  probabilities: {
    record_only: action === 'record_only' ? 0.8 : 0.04,
    notify: action === 'notify' ? 0.8 : 0.04,
    wait: action === 'wait' ? 0.8 : 0.04,
    fetch_context: action === 'fetch_context' ? 0.8 : 0.04,
    dispatch_agent: action === 'dispatch_agent' ? 0.8 : 0.04,
    ask_user: action === 'ask_user' ? 0.8 : 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
})

describe('project event action drain', () => {
  let root: string
  let dbPath: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock: number
  let deliveries: number

  function open(): ForgeLedgerContext {
    const opened = openForgeInboxDatabase(dbPath, 'host-1')
    return { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
  }

  function record(action: ProjectEventDecisionAction, body = MR_BODY, key?: string): number {
    const deliveryId = admit(`delivery-${key ?? deliveries++}`, body)
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected a project event decision claim')
    }
    const result = decideProjectEventDelivery(ctx, deliveryId, decision(action), claim)
    if (!result.ok) {
      throw new Error('fixture could not record the decision')
    }
    return deliveryId
  }

  function admit(dedupeKey: string, body: Buffer): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: body === PIPELINE_RUNNING_BODY ? 'Pipeline Hook' : 'Merge Request Hook',
      dedupeKey,
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    return admitted.deliveryId
  }

  function latestEventChange() {
    const row = ctx.db
      .prepare("SELECT * FROM changes WHERE entity = 'event' ORDER BY seq DESC LIMIT 1")
      .get()
    if (!row) {
      throw new Error('expected an ingested event change')
    }
    return changeFromRow(row)
  }

  function deliveryRow(id = 1) {
    return ctx.db
      .prepare(
        `SELECT state, decision_state, decision_token, next_attempt_at, attempts, parked_reason,
         policy_generation, last_error_code FROM webhook_deliveries WHERE id = ?`
      )
      .get(id)
  }

  function decisionRow(id = 1) {
    return ctx.db
      .prepare(
        'SELECT action_state, superseded, last_error_code FROM project_event_decisions WHERE id = ?'
      )
      .get(id)
  }

  function drainDeps(
    observeContext?: (claim: ProjectEventActionClaim) => Promise<ProjectEventHeadObservation>
  ) {
    return {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      ...(observeContext ? { observeContext } : {})
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

  function pendingDeliveries() {
    return ctx.db
      .prepare(
        `SELECT id, event_kind, dedupe_key, body FROM webhook_deliveries
         WHERE state = 'pending' ORDER BY id`
      )
      .all()
  }

  function bodyObject(body: unknown): Record<string, unknown> {
    if (!(body instanceof Uint8Array)) {
      throw new Error('expected a binary delivery body')
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object delivery body')
    }
    return parsed
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-action-drain-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    deliveries = 0
    store = fakeStore()
    ctx = open()
    bindingId = seedProjectEventQuestionPolicy(ctx, RULES)
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('notifies from a binding item under an enabled policy', async () => {
    record('notify')

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })

    expect(createForgeCandidateReader(ctx).candidateFor(latestEventChange())).toMatchObject({
      ownerId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      itemId: 1,
      reason: 'participating-update'
    })
    expect(deliveryRow()).toMatchObject({ state: 'done', decision_state: 'decided' })
  })

  it('notifies each distinct event while the reported head revision stays provisional', async () => {
    record('notify', MR_BODY, 'first')
    await drainProjectEventActions(ctx, drainDeps())
    expect(claimForgeNotifications(ctx).notifications).toMatchObject([
      { eventId: 1, reason: 'participating-update' }
    ])

    record('notify', MR_NEXT_BODY, 'second')
    await drainProjectEventActions(ctx, drainDeps())

    // The second event is observed after the first notification, so it is its own notification.
    expect(claimForgeNotifications(ctx).notifications).toMatchObject([
      { eventId: 2, reason: 'participating-update' }
    ])
    // A webhook-reported revision never advances the head, and keeps its provisional marker so a run
    // is never queued for it.
    expect(
      ctx.db
        .prepare(
          `SELECT i.current_revision, r.version_token FROM items i
           JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision`
        )
        .get()
    ).toEqual({ current_revision: 1, version_token: 'hook:sha-1' })
    expect(ctx.db.prepare('SELECT id, revision FROM events ORDER BY id').all()).toEqual([
      { id: 1, revision: 1 },
      { id: 2, revision: 1 }
    ])
  })

  it('stops treating the item as a notification candidate once the policy is disabled', async () => {
    record('notify')
    await drainProjectEventActions(ctx, drainDeps())
    const change = latestEventChange()
    expect(createForgeCandidateReader(ctx).candidateFor(change)).not.toBeNull()

    updateProjectEventPolicy(ctx, {
      repoId: PROJECT_EVENT_TEST_REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })

    expect(createForgeCandidateReader(ctx).candidateFor(change)).toBeNull()
  })

  it('parks a wait with the reason its reported pipeline status proves', async () => {
    record('wait', PIPELINE_RUNNING_BODY)

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })
    expect(decisionRow()).toMatchObject({ action_state: 'awaiting-event', superseded: 0 })
    expect(deliveryRow()).toMatchObject({ state: 'parked', parked_reason: 'pipeline-finishes' })
  })

  it('wakes a parked wait when a later event lands on the same item', async () => {
    record('wait')
    await drainProjectEventActions(ctx, drainDeps())
    expect(deliveryRow()).toMatchObject({ state: 'parked', decision_state: 'decided' })

    ingestForgeEvent(ctx, {
      hostId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      projectId: 'group/demo',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'observed-1',
      eventKind: 'Merge Request Hook',
      versionToken: 'sha256:observed',
      sourceOrder: 1,
      payload: { source: 'observed' }
    })

    expect(deliveryRow()).toMatchObject({
      state: 'pending',
      decision_state: 'queued',
      decision_token: null,
      next_attempt_at: null,
      attempts: 0,
      parked_reason: null,
      policy_generation: 1
    })
    expect(decisionRow()).toMatchObject({ action_state: 'awaiting-event', superseded: 1 })
    expect(claimProjectEventDecision(ctx)).not.toBeNull()
  })

  it('does not wake a wait while the binding policy is disabled', async () => {
    record('wait')
    await drainProjectEventActions(ctx, drainDeps())
    ctx.db
      .prepare('DELETE FROM project_event_policies WHERE repo_id = ?')
      .run(PROJECT_EVENT_TEST_REPO_ID)
    ctx.db
      .prepare(
        `INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation, updated_at)
         VALUES (?, ?, ?, 2, ?)`
      )
      .run(ctx.hostId, PROJECT_EVENT_TEST_REPO_ID, JSON.stringify({ enabled: false }), ctx.now())

    ingestForgeEvent(ctx, {
      hostId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      projectId: 'group/demo',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'observed-disabled',
      eventKind: 'Merge Request Hook',
      versionToken: 'sha256:observed',
      sourceOrder: 1,
      payload: { source: 'observed' }
    })

    expect(deliveryRow()).toMatchObject({ state: 'parked', decision_state: 'decided' })
    expect(decisionRow()).toMatchObject({ action_state: 'awaiting-event', superseded: 0 })
  })

  it('executes one batch per drain and reports the rest as capped', async () => {
    for (let index = 0; index < 9; index += 1) {
      record('notify')
    }
    expect(getProjectEventActionSchedule(ctx).pending).toBe(9)

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 8,
      failed: 0,
      capped: true
    })
    expect(getProjectEventActionSchedule(ctx).pending).toBe(1)

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })
    expect(getProjectEventActionSchedule(ctx)).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
  })

  it('wires every executable action and never claims the rest', async () => {
    expect(PROJECT_EVENT_WIRED_ACTIONS).toEqual([
      'notify',
      'wait',
      'fetch_context',
      'dispatch_agent',
      'ask_user'
    ])
    record('record_only')

    expect(getProjectEventActionSchedule(ctx)).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
    expect(claimProjectEventAction(ctx)).toBeNull()
    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 0,
      failed: 0,
      capped: false
    })
    expect(decisionRow()).toMatchObject({ action_state: 'done' })
  })

  it('counts a link failure as failed instead of crashing the drain', async () => {
    record('notify', NO_IID_BODY)

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 0,
      failed: 1,
      capped: false
    })
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'item-identity-missing'
    })
  })

  it('fetches the observed head once and re-decides it as a new delivery', async () => {
    record('fetch_context')
    let calls = 0
    const deps = drainDeps(async () => {
      calls += 1
      return observedHead()
    })

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })

    expect(calls).toBe(1)
    expect(decisionRow()).toMatchObject({ action_state: 'done' })
    expect(deliveryRow()).toMatchObject({ state: 'done' })
    const pending = pendingDeliveries()
    expect(pending).toHaveLength(1)
    const row = pending[0]
    if (!row) {
      throw new Error('expected the synthesized delivery')
    }
    expect(rowText(row, 'event_kind')).toBe('merge_request')
    expect(rowText(row, 'dedupe_key')).toBe('context:1:1:sha256:observed')
    expect(bodyObject(row.body)).toMatchObject({
      object_kind: 'merge_request',
      context_round: 1,
      context_source: 'observation'
    })
    expect(projectEventDecisionFacts(row.body)).toMatchObject({
      kind: 'merge_request',
      iid: 7,
      sha: OBSERVED_SHA,
      title: 'Add thing'
    })
  })

  it('records an unchanged head as a failure without admitting the same context again', async () => {
    record('fetch_context')

    expect(
      await drainProjectEventActions(
        ctx,
        drainDeps(async () => observedHead({ newRevision: false }))
      )
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'context-unchanged'
    })
    expect(deliveryRow()).toMatchObject({ state: 'failed', last_error_code: 'context-unchanged' })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('records an observation failure instead of synthesizing a delivery', async () => {
    record('fetch_context')

    expect(
      await drainProjectEventActions(
        ctx,
        drainDeps(async () => ({ ok: false, code: 'head-moved' }))
      )
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(decisionRow()).toMatchObject({ action_state: 'blocked', last_error_code: 'head-moved' })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('refuses a second context round before calling the observer', async () => {
    record('fetch_context', CONTEXT_ROUND_ONE_BODY)
    let calls = 0

    expect(
      await drainProjectEventActions(
        ctx,
        drainDeps(async () => {
          calls += 1
          return observedHead()
        })
      )
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(calls).toBe(0)
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'context-rounds-exhausted'
    })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('fails closed when the host wired no observation reader', async () => {
    record('fetch_context')

    expect(await drainProjectEventActions(ctx, drainDeps())).toEqual({
      executed: 0,
      failed: 1,
      capped: false
    })
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'context-unavailable'
    })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('records a full queue instead of settling the action as done', async () => {
    record('fetch_context')

    expect(
      await drainProjectEventActions(ctx, {
        limits: { maxPending: 0, maxQueuedBytes: 0 },
        observeContext: async () => observedHead()
      })
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(decisionRow()).toMatchObject({ action_state: 'blocked', last_error_code: 'queue-full' })
    expect(deliveryRow()).toMatchObject({ state: 'failed', last_error_code: 'queue-full' })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('re-admits an observed pipeline as a delivery about that same pipeline', async () => {
    record('fetch_context', PIPELINE_RUNNING_BODY)
    const observed = observedHead({
      kind: 'pipeline',
      iid: 11,
      title: 'Pipeline #11',
      state: 'success'
    })

    await drainProjectEventActions(
      ctx,
      drainDeps(async () => observed)
    )

    const [reread] = pendingDeliveries()
    expect(reread).toMatchObject({ event_kind: 'pipeline' })
    expect(projectEventSubject(reread?.body, 3)).toMatchObject({ kind: 'pipeline', iid: 11 })
    expect(bodyObject(reread?.body).object_attributes).toMatchObject({ id: 11, status: 'success' })
  })

  it('reuses the same synthesized delivery when the same decision re-observes the same head', async () => {
    record('fetch_context')
    const deps = drainDeps(async () => observedHead())
    await drainProjectEventActions(ctx, deps)
    expect(pendingDeliveries()).toHaveLength(1)

    // Why: a retried action re-links from the stored body; only the synthesis dedupe key guards it.
    ctx.db
      .prepare(
        `UPDATE project_event_decisions SET action_state = 'queued', action_token = NULL,
         action_finished_at = NULL WHERE id = 1`
      )
      .run()
    ctx.db.prepare('UPDATE webhook_deliveries SET body = ? WHERE id = 1').run(MR_BODY)

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get()).toEqual({ n: 2 })
    expect(pendingDeliveries()).toHaveLength(1)
    expect(decisionRow()).toMatchObject({ action_state: 'done' })
  })

  it('leaves an aborted observation unsettled so recovery can take it', async () => {
    record('fetch_context')
    const controller = new AbortController()
    const deps = drainDeps(async () => {
      controller.abort()
      return observedHead()
    })

    expect(await drainProjectEventActions(ctx, deps, controller.signal)).toEqual({
      executed: 0,
      failed: 0,
      capped: false
    })
    expect(decisionRow()).toMatchObject({ action_state: 'processing' })
    expect(deliveryRow()).toMatchObject({ state: 'pending' })
    expect(pendingDeliveries()).toHaveLength(1)

    recoverInterruptedProjectEventActions(ctx)
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'interrupted-action'
    })
  })

  it('refuses an identical second context read for the same reported revision', async () => {
    record('fetch_context')
    record('fetch_context')
    let reads = 0
    const deps = drainDeps(async () => {
      reads += 1
      return observedHead()
    })

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 1,
      failed: 1,
      capped: false
    })

    // Why: the second decision asks for a read whose result cannot differ from the first one.
    expect(reads).toBe(1)
    expect(decisionRow(1)).toMatchObject({ action_state: 'done' })
    expect(decisionRow(2)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'context-already-fetched'
    })
    expect(deliveryRow(2)).toMatchObject({
      state: 'failed',
      last_error_code: 'context-already-fetched'
    })
    expect(pendingDeliveries()).toHaveLength(1)
  })

  it('retries the same revision after a transient observation failure', async () => {
    record('fetch_context')
    record('fetch_context')
    let reads = 0
    const deps = drainDeps(async () => {
      reads += 1
      return reads === 1 ? { ok: false, code: 'network' } : observedHead()
    })

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 1,
      failed: 1,
      capped: false
    })

    // Why: a failure that produced no conclusion must not silence a later read of the same revision.
    expect(reads).toBe(2)
    expect(decisionRow(1)).toMatchObject({ action_state: 'blocked', last_error_code: 'network' })
    expect(decisionRow(2)).toMatchObject({ action_state: 'done' })
    expect(pendingDeliveries()).toHaveLength(1)
  })

  it('stops the re-decided chain at the round cap after one real fetch', async () => {
    record('fetch_context')
    let reads = 0
    const deps = drainDeps(async () => {
      reads += 1
      return observedHead()
    })

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 1,
      failed: 0,
      capped: false
    })
    const [synthesized] = pendingDeliveries()
    if (!synthesized) {
      throw new Error('expected the synthesized delivery')
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected the synthesized delivery to be decidable')
    }
    expect(
      decideProjectEventDelivery(
        ctx,
        rowNumber(synthesized, 'id'),
        decision('fetch_context'),
        claim
      ).ok
    ).toBe(true)

    expect(await drainProjectEventActions(ctx, deps)).toEqual({
      executed: 0,
      failed: 1,
      capped: false
    })
    expect(reads).toBe(1)
    expect(decisionRow(2)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'context-rounds-exhausted'
    })
    expect(pendingDeliveries()).toHaveLength(0)
  })

  it('claims fetch_context now that an executor is wired', () => {
    record('fetch_context')

    expect(getProjectEventActionSchedule(ctx).pending).toBe(1)
    expect(claimProjectEventAction(ctx)).toMatchObject({ action: 'fetch_context' })
  })
})

describe('projectEventWaitReason', () => {
  it.each([
    ['a running pipeline', { kind: 'pipeline', status: 'running' }, 'pipeline-finishes'],
    ['a pending pipeline', { kind: 'pipeline', status: 'pending' }, 'pipeline-finishes'],
    ['a finished pipeline', { kind: 'pipeline', status: 'success' }, 'next-event'],
    [
      'a conflicted merge request',
      { kind: 'merge_request', hasConflicts: true },
      'conflict-resolved'
    ],
    [
      'an unmergeable merge request',
      { kind: 'merge_request', mergeStatus: 'cannot_be_merged' },
      'conflict-resolved'
    ],
    ['a mergeable merge request', { kind: 'merge_request' }, 'next-event'],
    ['a note', { kind: 'note' }, 'user-reply'],
    ['an assigned issue', { kind: 'issue', action: 'assigned' }, 'next-event'],
    ['nothing recognisable', {}, 'next-event']
  ])('derives from %s', (_label, facts, expected) => {
    expect(projectEventWaitReason(facts)).toBe(expected)
  })
})

describe('projectEventNotificationCategory', () => {
  it.each([
    ['a failed pipeline', { kind: 'pipeline', status: 'failed' }, 'pipeline-failure'],
    ['a successful pipeline', { kind: 'pipeline', status: 'success' }, null],
    ['an opened merge request', { kind: 'merge_request', action: 'open' }, 'review-request'],
    ['a reopened merge request', { kind: 'merge_request', action: 'reopen' }, 'review-request'],
    [
      'an updated merge request',
      { kind: 'merge_request', action: 'update' },
      'participating-update'
    ],
    [
      'an approved merge request',
      { kind: 'merge_request', action: 'approved' },
      'participating-update'
    ],
    ['a closed merge request', { kind: 'merge_request', action: 'close' }, null],
    ['an assigned issue', { kind: 'issue', action: 'assigned' }, 'issue-assignment'],
    ['an edited issue', { kind: 'issue', action: 'update' }, null],
    [
      'a note on a merge request',
      { kind: 'note', noteableType: 'MergeRequest' },
      'participating-update'
    ],
    ['a note on an issue', { kind: 'note', noteableType: 'Issue' }, 'issue-mention'],
    ['a note on a commit', { kind: 'note', noteableType: 'Commit' }, null],
    ['nothing recognisable', {}, null]
  ])('maps %s', (_label, facts, expected) => {
    expect(projectEventNotificationCategory(facts)).toBe(expected)
  })
})
