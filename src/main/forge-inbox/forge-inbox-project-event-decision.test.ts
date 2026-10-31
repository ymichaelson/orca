import { randomUUID } from 'node:crypto'
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
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import {
  FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
  getForgeWebhookQueueStatus
} from './forge-inbox-webhook-queue'
import { rowText } from './forge-inbox-rows'

const REPO_ID = 'repo-1'
const RULES = '合并请求需要评审。'
const BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { iid: 7, title: 'Add thing' },
    object_attributes: { action: 'update' }
  })
)

const decision = (
  action: ProjectEventDecisionAction,
  overrides: Partial<Extract<ProjectEventDecisionResult, { ok: true }>> = {}
): ProjectEventDecisionResult => ({
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
  usage: { inputTokens: 10, outputTokens: 2 },
  ...overrides
})

describe('project event delivery decision', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  let deliveryId: number

  const delivery = () =>
    ctx.db
      .prepare('SELECT state, length(body) AS bytes FROM webhook_deliveries WHERE id = ?')
      .get(deliveryId)

  const decisions = () =>
    ctx.db
      .prepare(
        'SELECT delivery_id, action, provider, model, policy_generation FROM project_event_decisions'
      )
      .all()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-decision-'))
    let clock = 1000
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    store = fakeStore()
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
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
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: 'delivery-1',
      correlation: { eventUuid: null, configUuid: null },
      body: BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    deliveryId = admitted.deliveryId
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('tells the decision whether another context round is still available', () => {
    expect(claimProjectEventDecision(ctx)?.input.context).toMatchObject({
      contextRound: 0,
      contextFetchAvailable: true
    })
  })

  it('does not offer a context fetch for a project-level event', () => {
    decideProjectEventDelivery(
      ctx,
      deliveryId,
      decision('record_only'),
      claimProjectEventDecision(ctx) ?? undefined
    )
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Push Hook',
      dedupeKey: 'push-1',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from(
        JSON.stringify({
          object_kind: 'push',
          project: { id: 3 },
          ref: 'refs/heads/main',
          after: 'a'.repeat(40)
        })
      )
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }

    expect(claimProjectEventDecision(ctx)?.input.context).toMatchObject({
      contextRound: 0,
      contextFetchAvailable: false
    })
  })

  it('names the item its event is about, so a queued action is visible before it is claimed', () => {
    const admitted = ctx.db
      .prepare('SELECT project_id FROM webhook_deliveries WHERE id = ?')
      .get(deliveryId)
    if (!admitted) {
      throw new Error('missing admitted delivery')
    }
    const projectId = rowText(admitted, 'project_id')
    const inserted = ctx.db
      .prepare(
        `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title, state,
         current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES (?, 'gitlab:gitlab.test', ?, 'merge_request', 7, 'Add thing', 'opened', 1, 1, 1, ?, ?)`
      )
      .run(ctx.hostId, projectId, ctx.now(), ctx.now())

    decideProjectEventDelivery(
      ctx,
      deliveryId,
      decision('dispatch_agent'),
      claimProjectEventDecision(ctx) ?? undefined
    )

    expect(
      ctx.db
        .prepare('SELECT item_id FROM project_event_decisions WHERE delivery_id = ?')
        .get(deliveryId)
    ).toEqual({ item_id: Number(inserted.lastInsertRowid) })
  })

  it('does not invent an item for a decision whose event names none yet', () => {
    decideProjectEventDelivery(
      ctx,
      deliveryId,
      decision('dispatch_agent'),
      claimProjectEventDecision(ctx) ?? undefined
    )

    expect(
      ctx.db
        .prepare('SELECT item_id FROM project_event_decisions WHERE delivery_id = ?')
        .get(deliveryId)
    ).toEqual({ item_id: null })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 0 })
  })

  it('records a decision and finishes the delivery when nothing more is required', () => {
    const result = decideProjectEventDelivery(
      ctx,
      deliveryId,
      decision('record_only'),
      claimProjectEventDecision(ctx) ?? undefined
    )

    expect(result).toEqual({ ok: true, action: 'record_only' })
    expect(delivery()).toEqual({ state: 'done', bytes: 0 })
    expect(decisions()).toEqual([
      {
        delivery_id: deliveryId,
        action: 'record_only',
        provider: 'jev',
        model: 'jev-1',
        policy_generation: 1
      }
    ])
  })

  it.each([
    [
      'a foreign project',
      { object_kind: 'merge_request', project: { id: 99 } },
      'event-project-mismatch'
    ],
    [
      'a merge request naming no item',
      { object_kind: 'merge_request', project: { id: 3 } },
      'item-identity-missing'
    ],
    [
      'a note on a merge request naming no target',
      {
        object_kind: 'note',
        project: { id: 3, path_with_namespace: 'group/demo' },
        object_attributes: { noteable_type: 'MergeRequest', note: 'hi' }
      },
      'invalid-input'
    ]
  ])('leaves a typed diagnostic when record_only cannot record %s', (_name, payload, code) => {
    const itemCount = () => ctx.db.prepare('SELECT count(*) AS n FROM items').get()
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Hook',
      dedupeKey: 'refused-subject',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from(JSON.stringify(payload))
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const before = itemCount()
    const claim = claimProjectEventDecision(ctx)
    if (!claim || claim.deliveryId !== deliveryId) {
      throw new Error('fixture expected the first delivery to be claimed')
    }
    decideProjectEventDelivery(ctx, deliveryId, decision('record_only'), claim)
    const second = claimProjectEventDecision(ctx)
    if (!second) {
      throw new Error('fixture could not claim the refused delivery')
    }
    decideProjectEventDelivery(ctx, admitted.deliveryId, decision('record_only'), second)

    expect(
      ctx.db
        .prepare(
          'SELECT state, last_error_code, length(body) AS bytes FROM webhook_deliveries WHERE id = ?'
        )
        .get(admitted.deliveryId)
    ).toEqual({ state: 'done', last_error_code: code, bytes: 0 })
    expect(itemCount()).toEqual(before)
  })

  it.each(['notify', 'wait', 'fetch_context', 'dispatch_agent', 'ask_user'] as const)(
    'keeps %s unfinished without pretending an effect occurred',
    (action) => {
      const result = decideProjectEventDelivery(
        ctx,
        deliveryId,
        decision(action),
        claimProjectEventDecision(ctx) ?? undefined
      )

      expect(result).toEqual({ ok: true, action })
      expect(delivery()).toEqual({ state: 'pending', bytes: BODY.length })
      expect(decisions()).toMatchObject([{ action }])
      expect(
        ctx.db.prepare('SELECT decision_state FROM webhook_deliveries WHERE id = ?').get(deliveryId)
      ).toEqual({ decision_state: 'decided' })
    }
  )

  it('keeps the delivery pending and records nothing when the decision fails', () => {
    const result = decideProjectEventDelivery(
      ctx,
      deliveryId,
      {
        ok: false,
        code: 'rate-limited',
        retryAfterMs: 1000
      },
      claimProjectEventDecision(ctx) ?? undefined
    )

    expect(result).toEqual({ ok: false, reason: 'decision-failed' })
    expect(delivery()).toMatchObject({ state: 'pending' })
    expect(decisions()).toEqual([])
  })

  it('finishes the delivery when the decision can never succeed', () => {
    const result = decideProjectEventDelivery(
      ctx,
      deliveryId,
      { ok: false, code: 'unauthorized' },
      claimProjectEventDecision(ctx) ?? undefined
    )

    expect(result).toEqual({ ok: false, reason: 'decision-failed' })
    // A non-retryable failure is terminal: keeping the row pending would hold its queue slot forever.
    expect(delivery()).toEqual({ state: 'failed', bytes: 0 })
    expect(
      ctx.db
        .prepare('SELECT decision_state, last_error_code FROM webhook_deliveries WHERE id = ?')
        .get(deliveryId)
    ).toEqual({ decision_state: 'blocked', last_error_code: 'unauthorized' })
    expect(decisions()).toEqual([])
  })

  it('finishes a delivery whose stored body cannot be parsed into decision facts', () => {
    decideProjectEventDelivery(
      ctx,
      deliveryId,
      decision('record_only'),
      claimProjectEventDecision(ctx) ?? undefined
    )
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: 'invalid-body',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from('{ not json')
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }

    expect(claimProjectEventDecision(ctx)).toBeNull()

    // Nothing can decide this row, so it must not keep its queue slot or payload.
    expect(
      ctx.db
        .prepare(
          `SELECT state, decision_state, last_error_code, length(body) AS bytes,
           finished_at IS NULL AS unfinished FROM webhook_deliveries WHERE id = ?`
        )
        .get(admitted.deliveryId)
    ).toEqual({
      state: 'failed',
      decision_state: 'blocked',
      last_error_code: 'invalid-input',
      bytes: 0,
      unfinished: 0
    })
    expect(getForgeWebhookQueueStatus(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS).pending).toBe(0)
  })

  it('finishes a delivery whose policy was disabled before it was claimed', () => {
    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
           policy_generation, admitted_at, state, body, decision_state)
         VALUES (?, ?, 'group/demo', 'delivery-2', 'Merge Request Hook', 2, 5, 'pending', x'01', 'queued')`
      )
      .run(ctx.hostId, bindingId)

    expect(claimProjectEventDecision(ctx)).toBeNull()

    expect(
      ctx.db
        .prepare(
          `SELECT state, decision_state, last_error_code, length(body) AS bytes,
           finished_at IS NULL AS unfinished FROM webhook_deliveries ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        state: 'failed',
        decision_state: 'cancelled',
        last_error_code: 'policy-disabled',
        bytes: 0,
        unfinished: 0
      },
      {
        state: 'failed',
        decision_state: 'cancelled',
        last_error_code: 'policy-disabled',
        bytes: 0,
        unfinished: 0
      }
    ])
    expect(getForgeWebhookQueueStatus(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS).pending).toBe(0)
  })

  it('finishes the delivery when its policy is disabled while the decision is in flight', () => {
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected a project event decision claim')
    }

    updateProjectEventPolicy(ctx, {
      repoId: REPO_ID,
      expectedGeneration: 1,
      patch: { enabled: false }
    })

    expect(decideProjectEventDelivery(ctx, deliveryId, decision('notify'), claim)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(delivery()).toMatchObject({ state: 'failed', bytes: 0 })
    expect(
      ctx.db
        .prepare(
          `SELECT decision_state, last_error_code, finished_at IS NULL AS unfinished
           FROM webhook_deliveries WHERE id = ?`
        )
        .get(deliveryId)
    ).toEqual({ decision_state: 'cancelled', last_error_code: 'policy-disabled', unfinished: 0 })
    expect(getForgeWebhookQueueStatus(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS).pending).toBe(0)
  })

  it('refuses a delivery the retired worker owns', () => {
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
           config_revision, admitted_at, state, body)
         VALUES (?, 'gitlab-main', '42', 'msg:old', 'Merge Request Hook', 1, 1, 'pending', x'01')`
      )
      .run(ctx.hostId)
    const instanceRow = ctx.db.prepare('SELECT max(id) AS id FROM webhook_deliveries').get()

    const result = decideProjectEventDelivery(
      ctx,
      Number(instanceRow && instanceRow.id),
      decision('record_only')
    )

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(decisions()).toEqual([])
  })
})
