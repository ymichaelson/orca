import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_EVENT_DECISION_ACTIONS,
  type ProjectEventDecisionAction,
  type ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ingestForgeEvent, queueForgeItemRun } from './forge-inbox-ingest'
import { recoverInterruptedForgeWork } from './forge-inbox-interrupted-work'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  claimProjectEventAction,
  getProjectEventActionSchedule,
  linkProjectEventDecisionItem,
  recoverInterruptedProjectEventActions,
  settleProjectEventAction,
  type ProjectEventActionClaim
} from './forge-inbox-project-event-action'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import {
  admitProjectEventDelivery,
  resumeParkedProjectEventDeliveries
} from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
  getForgeWebhookQueueStatus
} from './forge-inbox-webhook-queue'

const REPO_ID = 'repo-1'
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
const NO_IID_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { title: 'missing' }
  })
)

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

describe('project event decision actions', () => {
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

  function reopen(): void {
    ctx.db.close()
    ctx = open()
  }

  function admit(dedupeKey: string, body: Buffer): number {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey,
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    return admitted.deliveryId
  }

  function record(action: ProjectEventDecisionAction, body = MR_BODY): number {
    const deliveryId = admit(`delivery-${deliveries++}`, body)
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

  function mustClaim(
    actions: readonly ProjectEventDecisionAction[] = PROJECT_EVENT_DECISION_ACTIONS
  ): ProjectEventActionClaim {
    const claim = claimProjectEventAction(ctx, actions)
    if (!claim) {
      throw new Error('expected a project event action claim')
    }
    return claim
  }

  function actionRow(decisionId: number) {
    return ctx.db
      .prepare(
        `SELECT action_state, action_token, action_started_at, action_finished_at,
         last_error_code, item_id FROM project_event_decisions WHERE id = ?`
      )
      .get(decisionId)
  }

  function deliveryRow(deliveryId: number) {
    return ctx.db
      .prepare(
        `SELECT state, parked_reason, finished_at, last_error_code, length(body) AS bytes
         FROM webhook_deliveries WHERE id = ?`
      )
      .get(deliveryId)
  }

  function queuePending(): number {
    return getForgeWebhookQueueStatus(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS).pending
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-action-'))
    dbPath = join(root, 'forge-inbox.sqlite')
    clock = 1000
    deliveries = 0
    store = fakeStore()
    ctx = open()
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
      patch: { enabled: true, rules: RULES }
    })
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('claims the oldest queued action and marks it processing', () => {
    record('notify')
    record('dispatch_agent')

    const schedule = getProjectEventActionSchedule(ctx, PROJECT_EVENT_DECISION_ACTIONS)
    expect(schedule).toMatchObject({ pending: 2, needsAuth: 0 })
    expect(schedule.nextAttemptAtMs).toEqual(expect.any(Number))
    const first = mustClaim()
    expect(first).toMatchObject({
      decisionId: 1,
      action: 'notify',
      bindingId,
      repoId: REPO_ID
    })
    expect(first.token).toEqual(expect.any(String))
    expect(actionRow(1)).toMatchObject({
      action_state: 'processing',
      action_token: first.token,
      action_started_at: first.startedAt
    })

    const second = mustClaim()
    expect(second).toMatchObject({ decisionId: 2, action: 'dispatch_agent' })
    expect(claimProjectEventAction(ctx)).toBeNull()
  })

  it('does not re-take a claimed action after a reopen', () => {
    record('notify')
    const claim = mustClaim()
    reopen()

    expect(claimProjectEventAction(ctx)).toBeNull()
    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'processing',
      action_token: claim.token
    })
  })

  it('refuses a settle with the wrong token and changes nothing', () => {
    record('notify')
    const claim = mustClaim()
    const forged = { ...claim, token: 'not-the-token' }

    expect(settleProjectEventAction(ctx, forged, { kind: 'done' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'processing',
      action_token: claim.token
    })
  })

  it('records a blocked action with its error code', () => {
    record('dispatch_agent')
    const claim = mustClaim()

    expect(
      settleProjectEventAction(ctx, claim, { kind: 'blocked', code: 'agent-unavailable' })
    ).toEqual({ ok: true, actionState: 'blocked' })
    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'agent-unavailable',
      action_token: null
    })
    expect(getProjectEventActionSchedule(ctx).pending).toBe(0)
    expect(claimProjectEventAction(ctx)).toBeNull()
  })

  it('recovers an interrupted processing action to blocked and never claims it again', () => {
    record('notify')
    const claim = mustClaim()

    recoverInterruptedProjectEventActions(ctx)

    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'interrupted-action',
      action_token: null
    })
    expect(getProjectEventActionSchedule(ctx).pending).toBe(0)
    expect(claimProjectEventAction(ctx)).toBeNull()
  })

  it('stops counting a decision once a policy change supersedes it', () => {
    record('notify')
    expect(getProjectEventActionSchedule(ctx).pending).toBe(1)

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { rules: `${RULES}（修订）` }
    })

    expect(getProjectEventActionSchedule(ctx)).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
    expect(claimProjectEventAction(ctx)).toBeNull()
  })

  it('finishes a queued notify delivery when its policy is disabled', () => {
    const deliveryId = record('notify')

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })

    expect(getProjectEventActionSchedule(ctx).pending).toBe(0)
    expect(deliveryRow(deliveryId)).toEqual({
      state: 'failed',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: 'policy-disabled',
      bytes: 0
    })
    expect(
      ctx.db.prepare('SELECT decision_state FROM webhook_deliveries WHERE id = ?').get(deliveryId)
    ).toEqual({ decision_state: 'cancelled' })
    expect(queuePending()).toBe(0)
  })

  it('finishes a parked wait delivery when its policy is disabled', () => {
    const deliveryId = record('wait')
    const claim = mustClaim()
    settleProjectEventAction(ctx, claim, {
      kind: 'awaiting-event',
      waitReason: 'pipeline-finishes'
    })

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })

    expect(getProjectEventActionSchedule(ctx).pending).toBe(0)
    expect(deliveryRow(deliveryId)).toEqual({
      state: 'failed',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: 'policy-disabled',
      bytes: 0
    })
    expect(
      ctx.db.prepare('SELECT decision_state FROM webhook_deliveries WHERE id = ?').get(deliveryId)
    ).toEqual({ decision_state: 'cancelled' })
    expect(queuePending()).toBe(0)
  })

  it('cancels a superseded in-flight action without finishing the delivery a new decision owns', () => {
    const deliveryId = record('notify')
    const stale = mustClaim()

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { rules: `${RULES}（修订）` }
    })
    const redecided = claimProjectEventDecision(ctx)
    if (!redecided) {
      throw new Error('expected the requeued delivery to be claimed again')
    }
    expect(decideProjectEventDelivery(ctx, deliveryId, decision('notify'), redecided)).toEqual({
      ok: true,
      action: 'notify'
    })

    expect(settleProjectEventAction(ctx, stale, { kind: 'done' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(actionRow(stale.decisionId)).toMatchObject({
      action_state: 'cancelled',
      action_token: null,
      action_finished_at: expect.any(Number)
    })
    expect(deliveryRow(deliveryId)).toEqual({
      state: 'pending',
      parked_reason: null,
      finished_at: null,
      last_error_code: null,
      bytes: MR_BODY.length
    })

    const fresh = mustClaim()
    expect(fresh.decisionId).not.toBe(stale.decisionId)
    expect(linkProjectEventDecisionItem(ctx, fresh)).toMatchObject({
      ok: true,
      notificationCategory: 'participating-update'
    })
    expect(settleProjectEventAction(ctx, fresh, { kind: 'done' })).toEqual({
      ok: true,
      actionState: 'done'
    })
    expect(deliveryRow(deliveryId)).toMatchObject({ state: 'done', bytes: 0 })
  })

  it('recovers a superseded in-flight action without erasing the new decision payload', () => {
    const deliveryId = record('notify')
    const stale = mustClaim()

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { rules: `${RULES}（修订）` }
    })
    recoverInterruptedProjectEventActions(ctx)

    expect(actionRow(stale.decisionId)).toMatchObject({
      action_state: 'cancelled',
      action_token: null,
      action_finished_at: expect.any(Number)
    })
    expect(deliveryRow(deliveryId)).toEqual({
      state: 'pending',
      parked_reason: null,
      finished_at: null,
      last_error_code: null,
      bytes: MR_BODY.length
    })
    expect(
      ctx.db.prepare('SELECT decision_state FROM webhook_deliveries WHERE id = ?').get(deliveryId)
    ).toEqual({ decision_state: 'queued' })
  })

  it('never exposes record_only as a claimable action', () => {
    record('record_only')

    expect(getProjectEventActionSchedule(ctx)).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
    expect(claimProjectEventAction(ctx)).toBeNull()
    expect(actionRow(1)).toMatchObject({ action_state: 'done' })
  })

  it('links one item for two decisions on the same merge request without a second run', () => {
    record('dispatch_agent')
    const firstClaim = mustClaim()
    const firstLink = linkProjectEventDecisionItem(ctx, firstClaim)
    expect(firstLink).toMatchObject({ ok: true })
    expect(settleProjectEventAction(ctx, firstClaim, { kind: 'done' })).toMatchObject({ ok: true })

    record('dispatch_agent')
    const secondClaim = mustClaim()
    expect(linkProjectEventDecisionItem(ctx, secondClaim)).toEqual(firstLink)

    expect(
      ctx.db.prepare('SELECT id, instance_id, project_id, kind, iid, title FROM items').all()
    ).toEqual([
      {
        id: 1,
        instance_id: 'gitlab:gitlab.test',
        project_id: 'group/demo',
        kind: 'merge_request',
        iid: 7,
        title: 'Add thing'
      }
    ])
    expect(ctx.db.prepare('SELECT item_id, revision FROM events ORDER BY id').all()).toEqual([
      { item_id: 1, revision: 1 },
      { item_id: 1, revision: 1 }
    ])
    expect(ctx.db.prepare('SELECT count(*) AS n FROM item_revisions').get()).toEqual({ n: 1 })
    expect(ctx.db.prepare('SELECT item_id FROM project_event_decisions ORDER BY id').all()).toEqual(
      [{ item_id: 1 }, { item_id: 1 }]
    )

    // Only an authenticated head may be analysed; the hook revision alone never queues a paid run.
    expect(queueForgeItemRun(ctx, 1, 'review')).toBeNull()
    ingestForgeEvent(ctx, {
      hostId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      projectId: 'group/demo',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'observed-head',
      eventKind: 'Merge Request Hook',
      versionToken: 'sha256:observed',
      sourceOrder: 1,
      payload: { source: 'observed' }
    })
    expect(queueForgeItemRun(ctx, 1, 'review')).toEqual(expect.any(Number))
    expect(queueForgeItemRun(ctx, 1, 'review')).toBeNull()
  })

  it('blocks a dispatch with no item iid instead of inventing an item', () => {
    record('dispatch_agent', NO_IID_BODY)
    const claim = mustClaim()

    expect(linkProjectEventDecisionItem(ctx, claim)).toEqual({
      ok: false,
      reason: 'item-identity-missing'
    })
    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'item-identity-missing',
      action_token: null
    })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 0 })
    // Nothing can settle this action any more, so its delivery must not hold a queue slot.
    expect(deliveryRow(claim.deliveryId)).toEqual({
      state: 'failed',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: 'item-identity-missing',
      bytes: 0
    })
    expect(queuePending()).toBe(0)
  })

  it('parks a waiting action without finishing its delivery', () => {
    record('wait')
    const claim = mustClaim()

    expect(
      settleProjectEventAction(ctx, claim, {
        kind: 'awaiting-event',
        waitReason: 'pipeline-running'
      })
    ).toEqual({ ok: true, actionState: 'awaiting-event' })
    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'awaiting-event',
      action_token: null,
      action_finished_at: expect.any(Number),
      last_error_code: null
    })
    expect(deliveryRow(claim.deliveryId)).toEqual({
      state: 'parked',
      parked_reason: 'pipeline-running',
      finished_at: null,
      last_error_code: null,
      bytes: MR_BODY.length
    })
    expect(getProjectEventActionSchedule(ctx).pending).toBe(0)
    // A wait holds its payload but must not hold a pending queue slot for as long as it waits.
    expect(queuePending()).toBe(0)
  })

  it('never resumes a parked delivery whose waiting action already decided it', () => {
    record('wait')
    const claim = mustClaim()
    settleProjectEventAction(ctx, claim, { kind: 'awaiting-event', waitReason: 'pipeline-running' })

    expect(resumeParkedProjectEventDeliveries(ctx, { bindingId, policyGeneration: 1 })).toBe(0)
    expect(deliveryRow(claim.deliveryId)).toMatchObject({
      state: 'parked',
      parked_reason: 'pipeline-running'
    })
  })

  it('finishes a done delivery so its body and queue slot are released', () => {
    record('notify')
    const claim = mustClaim()

    expect(settleProjectEventAction(ctx, claim, { kind: 'done' })).toEqual({
      ok: true,
      actionState: 'done'
    })
    expect(deliveryRow(claim.deliveryId)).toEqual({
      state: 'done',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: null,
      bytes: 0
    })
    expect(queuePending()).toBe(0)
  })

  it('finishes a blocked delivery with its error code so it cannot fill the queue', () => {
    record('dispatch_agent')
    const claim = mustClaim()

    expect(
      settleProjectEventAction(ctx, claim, { kind: 'blocked', code: 'agent-unavailable' })
    ).toEqual({ ok: true, actionState: 'blocked' })
    expect(deliveryRow(claim.deliveryId)).toEqual({
      state: 'failed',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: 'agent-unavailable',
      bytes: 0
    })
    expect(queuePending()).toBe(0)
    expect(actionRow(claim.decisionId)).toMatchObject({
      last_error_code: 'agent-unavailable',
      action_finished_at: expect.any(Number)
    })
  })

  it('recovers a processing action when the host restarts', () => {
    record('notify')
    const claim = mustClaim()

    recoverInterruptedForgeWork(ctx)

    expect(actionRow(claim.decisionId)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'interrupted-action'
    })
    // The claim is gone, so nothing can settle it later: the delivery must be finished now.
    expect(deliveryRow(claim.deliveryId)).toEqual({
      state: 'failed',
      parked_reason: null,
      finished_at: expect.any(Number),
      last_error_code: 'interrupted-action',
      bytes: 0
    })
  })
})
