import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clampProjectEventActivityLimit,
  PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT,
  PROJECT_EVENT_ACTIVITY_MAX_LIMIT
} from '../../shared/forge-inbox-project-event-activity'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import {
  projectEventActivityOutcome,
  readProjectEventActivity
} from './forge-inbox-project-event-activity'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'

const BINDING_ID = '11111111-1111-4111-8111-111111111111'
const REPO_ID = 'repo-1'

type SeedInput = {
  admittedAt: number
  state: 'pending' | 'parked' | 'done' | 'failed' | 'needs-auth'
  parkedReason?: string | null
  decisionState?: string | null
  action?: string | null
  actionState?: string | null
  lastError?: string | null
  finishedAt?: number | null
  itemKind?: 'issue' | 'merge_request' | 'pipeline'
  itemIid?: number
  itemTitle?: string
  body?: unknown
}

describe('project event activity', () => {
  let root: string
  let ctx: ForgeLedgerContext
  let nextDedupe: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-activity-'))
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    let clock = 1_000
    ctx = {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => fakeStore()
    }
    upsertProjectBinding(ctx, {
      bindingId: BINDING_ID,
      projectPath: '/repo',
      gitlabHost: 'gitlab.example.com',
      gitlabPath: 'group/demo',
      gitlabProjectId: 42,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${BINDING_ID}`
    })
    linkProjectEventBinding(ctx, { repoId: REPO_ID, bindingId: BINDING_ID })
    nextDedupe = 1
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function seedEvent(input: SeedInput): number {
    const body =
      input.body === undefined
        ? Buffer.from(JSON.stringify({ object_kind: 'merge_request' }))
        : Buffer.from(JSON.stringify(input.body))
    const inserted = ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, binding_id, project_id, dedupe_key, event_kind,
           admitted_at, state, parked_reason, attempts, finished_at, last_error_code, body,
           decision_state)
         VALUES (?, ?, '42', ?, 'Merge Request Hook', ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(
        ctx.hostId,
        BINDING_ID,
        `dedupe-${nextDedupe++}`,
        input.admittedAt,
        input.state,
        input.parkedReason ?? null,
        input.finishedAt ?? null,
        input.lastError ?? null,
        body,
        input.decisionState ?? null
      )
    const deliveryId = Number(inserted.lastInsertRowid)
    if (input.itemKind !== undefined) {
      const item = ctx.db
        .prepare(
          `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title, state,
             current_revision, head_order, activity_seq, created_at, updated_at)
           VALUES (?, 'gitlab:gitlab.example.com', '42', ?, ?, ?, 'opened', 1, 0, 1, 1, 1)`
        )
        .run(ctx.hostId, input.itemKind, input.itemIid ?? 1, input.itemTitle ?? 'Item title')
      ctx.db
        .prepare(
          `INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation, provider,
             model, action, confidence, input_tokens, output_tokens, decided_at, superseded,
             action_state, item_id, last_error_code)
           VALUES (?, ?, 1, 'jev', 'model', ?, 1, 1, 1, 1, 0, ?, ?, ?)`
        )
        .run(
          ctx.hostId,
          deliveryId,
          input.action ?? 'notify',
          input.actionState ?? 'queued',
          Number(item.lastInsertRowid),
          input.lastError ?? null
        )
    }
    return deliveryId
  }

  it('maps every delivery combination and keeps an uncovered one unknown', () => {
    const cases = [
      { input: { deliveryState: 'done', action: 'record_only' }, outcome: 'recorded' },
      { input: { deliveryState: 'done', action: 'notify' }, outcome: 'notified' },
      { input: { deliveryState: 'done', action: 'dispatch_agent' }, outcome: 'done' },
      { input: { deliveryState: 'failed' }, outcome: 'failed' },
      { input: { deliveryState: 'needs-auth' }, outcome: 'needs-user' },
      { input: { deliveryState: null }, outcome: 'unknown' },
      {
        input: { deliveryState: 'parked', parkedReason: 'awaiting-user' },
        outcome: 'needs-user'
      },
      {
        input: { deliveryState: 'parked', parkedReason: 'awaiting-policy' },
        outcome: 'waiting'
      },
      {
        input: { deliveryState: 'parked', actionState: 'awaiting-event' },
        outcome: 'waiting'
      },
      { input: { deliveryState: 'pending', decisionState: 'queued' }, outcome: 'processing' },
      { input: { deliveryState: 'pending', decisionState: 'processing' }, outcome: 'processing' },
      { input: { deliveryState: 'pending', decisionState: 'retry' }, outcome: 'processing' },
      { input: { deliveryState: 'pending', decisionState: 'decided' }, outcome: 'processing' },
      { input: { deliveryState: 'pending', actionState: 'queued' }, outcome: 'processing' },
      { input: { deliveryState: 'pending', decisionState: 'cancelled' }, outcome: 'unknown' },
      { input: { deliveryState: 'parked', parkedReason: 'pipeline-running' }, outcome: 'unknown' },
      { input: { deliveryState: 'other' }, outcome: 'unknown' }
    ] as const
    for (const { input, outcome } of cases) {
      expect(
        projectEventActivityOutcome({
          deliveryState: input.deliveryState,
          parkedReason: 'parkedReason' in input ? input.parkedReason : null,
          decisionState: 'decisionState' in input ? input.decisionState : null,
          action: 'action' in input ? input.action : null,
          actionState: 'actionState' in input ? input.actionState : null
        }),
        JSON.stringify(input)
      ).toBe(outcome)
    }
  })

  it('reports a decided pending delivery as processing while its action waits to run', () => {
    const deliveryId = seedEvent({
      admittedAt: 1,
      state: 'pending',
      decisionState: 'decided'
    })

    expect(
      readProjectEventActivity(ctx, { repoId: REPO_ID }).events.find(
        (entry) => entry.id === deliveryId
      )
    ).toMatchObject({ outcome: 'processing' })
  })

  it('returns the newest events first with the item kind and no payload keys', () => {
    for (let index = 1; index <= 6; index++) {
      seedEvent({
        admittedAt: index,
        state: 'pending',
        decisionState: 'queued',
        itemKind: index % 2 === 0 ? 'merge_request' : 'issue',
        itemIid: index,
        itemTitle: `Event ${index}`
      })
    }

    const view = readProjectEventActivity(ctx, { repoId: REPO_ID })

    expect(view.events).toHaveLength(PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT)
    expect(view.events.map((entry) => entry.id)).toEqual([6, 5, 4, 3, 2])
    expect(view.events.every((entry) => entry.outcome === 'processing')).toBe(true)
    expect(view.events[0]).toMatchObject({
      kind: 'merge_request',
      iid: 6,
      title: 'Event 6',
      occurredAt: 6
    })
    const serialized = JSON.stringify(view)
    for (const forbidden of [
      'secret',
      'pendingSecret',
      'secret_envelope',
      'body',
      'payload',
      'prompt'
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
  })

  it('uses the item kind rather than the hook name', () => {
    seedEvent({
      admittedAt: 1,
      state: 'pending',
      decisionState: 'queued',
      itemKind: 'issue',
      itemIid: 9,
      body: { object_kind: 'merge_request', object_attributes: { iid: 9, title: 'From hook' } }
    })

    expect(readProjectEventActivity(ctx, { repoId: REPO_ID }).events[0]).toMatchObject({
      kind: 'issue',
      iid: 9
    })
  })

  it('falls back to bounded body facts when no item is linked yet', () => {
    const title = 'x'.repeat(600)
    seedEvent({
      admittedAt: 1,
      state: 'pending',
      decisionState: 'queued',
      body: { object_kind: 'issue', object_attributes: { iid: 12, title } }
    })

    expect(readProjectEventActivity(ctx, { repoId: REPO_ID }).events[0]).toMatchObject({
      kind: 'issue',
      iid: 12,
      title: 'x'.repeat(512)
    })
  })

  it('reports the latest terminal event outside the visible window', () => {
    const terminal = seedEvent({
      admittedAt: 1,
      state: 'done',
      decisionState: 'decided',
      finishedAt: 1,
      action: 'record_only',
      actionState: 'done',
      itemKind: 'merge_request',
      itemIid: 3,
      itemTitle: 'Old processed event'
    })
    for (let index = 2; index <= 7; index++) {
      seedEvent({ admittedAt: index, state: 'pending', decisionState: 'queued' })
    }

    const view = readProjectEventActivity(ctx, { repoId: REPO_ID })

    expect(view.events).toHaveLength(5)
    expect(view.events.some((entry) => entry.id === terminal)).toBe(false)
    expect(view.lastProcessed).toMatchObject({
      id: terminal,
      kind: 'merge_request',
      outcome: 'recorded'
    })
  })

  it('carries the finish time apart from the admission time', () => {
    const id = seedEvent({
      admittedAt: 1_000,
      state: 'done',
      decisionState: 'decided',
      finishedAt: 9_000,
      action: 'record_only',
      actionState: 'done'
    })

    const view = readProjectEventActivity(ctx, { repoId: REPO_ID })

    expect(view.lastProcessed).toMatchObject({ id, occurredAt: 1_000, finishedAt: 9_000 })
  })

  it('reports no last processed event when none reached a terminal state', () => {
    seedEvent({ admittedAt: 1, state: 'parked', parkedReason: 'awaiting-user' })

    expect(readProjectEventActivity(ctx, { repoId: REPO_ID }).lastProcessed).toBeNull()
  })

  it('excludes deliveries admitted for the retired per-instance flow', () => {
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
           admitted_at, state, attempts, body)
         VALUES (?, 'gitlab-main', '42', 'legacy', 'Merge Request Hook', 99, 'pending', 0, ?)`
      )
      .run(ctx.hostId, Buffer.from('{}'))
    seedEvent({ admittedAt: 1, state: 'pending', decisionState: 'queued' })

    expect(
      readProjectEventActivity(ctx, { repoId: REPO_ID }).events.map((entry) => entry.id)
    ).toHaveLength(1)
  })

  it('clamps an out-of-range limit instead of returning an empty or unbounded page', () => {
    seedEvent({ admittedAt: 1, state: 'pending', decisionState: 'queued' })
    seedEvent({ admittedAt: 2, state: 'pending', decisionState: 'queued' })

    expect(readProjectEventActivity(ctx, { repoId: REPO_ID, limit: 0 }).events).toHaveLength(1)
    expect(readProjectEventActivity(ctx, { repoId: REPO_ID, limit: 99 }).events).toHaveLength(2)
    expect(clampProjectEventActivityLimit(Number.NaN)).toBe(PROJECT_EVENT_ACTIVITY_DEFAULT_LIMIT)
    expect(clampProjectEventActivityLimit(99)).toBe(PROJECT_EVENT_ACTIVITY_MAX_LIMIT)
  })
})
