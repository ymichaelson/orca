import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { createForgeInboxCoordinator } from './forge-inbox-coordinator'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { ingestForgeEvent, queueForgeItemRun } from './forge-inbox-ingest'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  PROJECT_EVENT_TEST_REPO_ID,
  projectEventQuestionDecision,
  seedProjectEventQuestionPolicy
} from './forge-inbox-project-event-question-test-kit'
import { transitionForgeRun } from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const PUSH = {
  object_kind: 'push',
  project: { id: 3 },
  ref: 'refs/heads/feature',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40)
}

describe('analysis coordinator beside project event binding runs', () => {
  let root: string
  let ledger: ForgeInboxLedger
  let ctx: ForgeLedgerContext
  let bindingId: string
  let policyGeneration: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-coordinator-'))
    const path = join(root, 'forge-inbox.sqlite')
    // The coordinator's own connection opens first: opening it later would reconcile the run under test.
    ledger = ForgeInboxLedger.open(path, { hostId: 'host-1', secretStore: fakeStore() })
    const opened = openForgeInboxDatabase(path, 'host-1')
    let clock = 1000
    ctx = {
      db: opened.db,
      hostId: opened.hostId,
      now: () => ++clock,
      secretStore: () => fakeStore()
    }
    bindingId = seedProjectEventQuestionPolicy(ctx)
    const configured = updateProjectEventPolicy(ctx, {
      repoId: PROJECT_EVENT_TEST_REPO_ID,
      expectedGeneration: 1,
      patch: { agentId: 'claude' }
    })
    if (!configured.ok) {
      throw new Error('fixture could not choose the Agent')
    }
    policyGeneration = configured.generation
  })

  afterEach(() => {
    ctx.db.close()
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function drainCoordinator(): Promise<void> {
    const coordinator = createForgeInboxCoordinator({
      ledger,
      scope: {},
      analyse: async () => ({ kind: 'unknown' })
    })
    await coordinator.drainOnce()
  }

  function runs() {
    return ctx.db.prepare('SELECT id, state, error, policy_generation FROM runs ORDER BY id').all()
  }

  it('leaves a running project event dispatch alone', async () => {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration,
      policyEnabled: true,
      eventKind: 'Push Hook',
      dedupeKey: 'push-1',
      correlation: { eventUuid: null, configUuid: null },
      body: Buffer.from(JSON.stringify(PUSH))
    })
    const claim = claimProjectEventDecision(ctx)
    if (!admitted.ok || !claim) {
      throw new Error('fixture could not admit a push')
    }
    decideProjectEventDelivery(
      ctx,
      admitted.deliveryId,
      projectEventQuestionDecision('dispatch_agent'),
      claim
    )
    await drainProjectEventActions(ctx, {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      launchAgentFactory: () => async () => ({
        ok: true,
        mode: 'terminal',
        sessionId: null,
        promptOutcome: 'handed-to-terminal'
      }),
      launchAgentLedger: ledger
    })
    expect(runs()).toEqual([
      { id: 1, state: 'running', error: null, policy_generation: policyGeneration }
    ])

    await drainCoordinator()

    expect(runs()).toEqual([
      { id: 1, state: 'running', error: null, policy_generation: policyGeneration }
    ])
  })

  it('leaves a running merge request run of a project binding alone', async () => {
    const ingested = ingestForgeEvent(ctx, {
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
    if (ingested.duplicate) {
      throw new Error('fixture event was a duplicate')
    }
    const runId = queueForgeItemRun(ctx, ingested.itemId, 'project-event-dispatch')
    if (runId === null || !transitionForgeRun(ctx, runId, { to: 'running' }).ok) {
      throw new Error('fixture could not start a run')
    }

    await drainCoordinator()

    expect(runs()).toEqual([
      { id: runId, state: 'running', error: null, policy_generation: policyGeneration }
    ])
  })
})
