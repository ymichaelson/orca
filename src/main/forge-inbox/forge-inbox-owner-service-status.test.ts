import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import {
  closeForgeOwnerRunning,
  openForgeOwnerRunning,
  type ForgeOwnerRunning
} from './forge-inbox-owner-running'
import {
  createOwnerFixture,
  PROJECT_EVENT_BINDING_ID,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { forgeOwnerIdle, forgeOwnerStatus } from './forge-inbox-owner-service-status'
import { seedRun } from './forge-inbox-project-event-run-cancel-test-kit'
import { transitionForgeRun } from './forge-inbox-runs'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 42 },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)

const NOTIFY: ProjectEventDecisionResult = {
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action: 'notify',
  confidence: 0.8,
  probabilities: {
    record_only: 0.04,
    notify: 0.8,
    wait: 0.04,
    fetch_context: 0.04,
    dispatch_agent: 0.04,
    ask_user: 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
}

describe('forge owner service idle state', () => {
  let fx: OwnerFixture
  let state: ForgeOwnerRunning | null = null
  let clock = 1000

  beforeEach(async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    state = openForgeOwnerRunning(
      {
        dbPath: fx.dbPath,
        http: fx.gate.http,
        secretStore: fx.store,
        receiverSettings: fx.receiverSettings,
        ingress: { requestDeadlineMs: 30_000, shutdownGraceMs: 200 },
        now: () => ++clock
      },
      undefined
    )
    // The scheduler must not settle the queued action before the idle check observes it.
    await state.actions.stop()
  })

  afterEach(async () => {
    if (state) {
      await closeForgeOwnerRunning(state, Promise.resolve())
      state = null
    }
    await fx.dispose()
  })

  it('is not idle while an action is queued, and idle again once it settles', async () => {
    if (!state) {
      throw new Error('expected a running owner')
    }
    const ctx = state.ledger.ledgerContext()
    expect(forgeOwnerIdle(state)).toBe(true)

    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId: PROJECT_EVENT_BINDING_ID,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: 'notify-1',
      correlation: { eventUuid: null, configUuid: null },
      body: BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('expected a project event decision claim')
    }
    expect(decideProjectEventDelivery(ctx, admitted.deliveryId, NOTIFY, claim)).toEqual({
      ok: true,
      action: 'notify'
    })

    expect(forgeOwnerStatus('running', state).work.pending).toBe(1)
    expect(forgeOwnerIdle(state)).toBe(false)

    expect(
      await drainProjectEventActions(ctx, { limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS })
    ).toEqual({ executed: 1, failed: 0, capped: false })
    expect(forgeOwnerIdle(state)).toBe(true)
  })

  it('names the run the host is executing, and drops it once that run settles', () => {
    if (!state) {
      throw new Error('expected a running owner')
    }
    const runId = seedRun(state.ledger, { iid: 71, title: 'Fix the thing' })

    const active = forgeOwnerStatus('running', state).activeRuns
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ runId, itemTitle: 'Fix the thing' })
    expect(active[0]?.since).toEqual(expect.any(Number))

    transitionForgeRun(state.ledger.ledgerContext(), runId, { to: 'succeeded' })

    expect(forgeOwnerStatus('running', state).activeRuns).toEqual([])
  })
})

describe('forge owner service draining status', () => {
  let fx: OwnerFixture
  let state: ForgeOwnerRunning | null = null

  beforeEach(async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
  })

  afterEach(async () => {
    if (state) {
      await closeForgeOwnerRunning(state, Promise.resolve())
      state = null
    }
    await fx.dispose()
  })

  it('reports draining and not idle while the decision client is in flight', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let started!: () => void
    const inFlight = new Promise<void>((resolve) => (started = resolve))
    state = openForgeOwnerRunning(
      {
        dbPath: fx.dbPath,
        http: fx.gate.http,
        secretStore: fx.store,
        receiverSettings: fx.receiverSettings,
        ingress: { requestDeadlineMs: 30_000, shutdownGraceMs: 200 },
        decideProjectEvent: async () => {
          started()
          await held
          return NOTIFY
        }
      },
      undefined
    )
    const running = state
    const decisions = running.decisions
    if (!decisions) {
      throw new Error('expected a decision scheduler')
    }
    // Isolate the decision term: a live action drain would mask it in the aggregate.
    await running.actions.stop()
    const admitted = admitProjectEventDelivery(
      running.ledger.ledgerContext(),
      FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      {
        bindingId: PROJECT_EVENT_BINDING_ID,
        projectPath: 'group/demo',
        policyGeneration: 1,
        policyEnabled: true,
        eventKind: 'Merge Request Hook',
        dedupeKey: 'draining-1',
        correlation: { eventUuid: null, configUuid: null },
        body: BODY
      }
    )
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }

    decisions.wake()
    await inFlight
    try {
      expect(forgeOwnerStatus('running', running).work.draining).toBe(true)
      expect(forgeOwnerIdle(running)).toBe(false)
    } finally {
      release()
    }
    await decisions.settled()
    expect(forgeOwnerStatus('running', running).work.draining).toBe(false)
  })
})
