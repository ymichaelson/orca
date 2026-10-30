import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createOwnerFixture,
  listenerOn,
  PROJECT_EVENT_BINDING_ID,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { rowNumber } from './forge-inbox-rows'
import { bindForgeRunSession } from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const DISPATCH: ProjectEventDecisionResult = {
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action: 'dispatch_agent',
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

describe('forge owner action network readiness', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('leaves a previously queued action untouched until the network is ready', async () => {
    fx = createOwnerFixture()
    const { port } = await seedLedger(fx)
    const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
    try {
      const ctx = ledger.ledgerContext()
      expect(
        updateProjectEventPolicy(ctx, {
          repoId: 'repo-1',
          expectedGeneration: 1,
          patch: { agentId: 'claude', rules: 'rules' }
        }).ok
      ).toBe(true)
      const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
        bindingId: PROJECT_EVENT_BINDING_ID,
        projectPath: 'group/demo',
        policyGeneration: 2,
        policyEnabled: true,
        eventKind: 'Merge Request Hook',
        dedupeKey: 'network-gate',
        correlation: { eventUuid: null, configUuid: null },
        body: Buffer.from(
          JSON.stringify({
            object_kind: 'merge_request',
            project: { id: 42 },
            merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
            object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
          })
        )
      })
      if (!admitted.ok) {
        throw new Error(`fixture could not admit: ${admitted.reason}`)
      }
      const claim = claimProjectEventDecision(ctx)
      if (!claim) {
        throw new Error('expected a project event decision claim')
      }
      expect(decideProjectEventDelivery(ctx, admitted.deliveryId, DISPATCH, claim)).toEqual({
        ok: true,
        action: 'dispatch_agent'
      })
    } finally {
      ledger.close()
    }

    let ready!: () => void
    const networkReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    let launches = 0
    const service = fx.service({
      networkReady,
      observeProjectEventContext: (opened) => async () => {
        const ctx = opened.ledgerContext()
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
            "INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at) VALUES (?, ?, 'sha256:observed', ?, ?)"
          )
          .run(itemId, revision, revision, ctx.now())
        ctx.db
          .prepare('UPDATE items SET current_revision = ?, updated_at = ? WHERE id = ?')
          .run(revision, ctx.now(), itemId)
        return {
          ok: true,
          itemId,
          revision,
          versionToken: 'sha256:observed',
          complete: true,
          newRevision: true,
          kind: 'merge_request',
          iid: 7,
          sha: 'a'.repeat(40),
          title: 'Add thing',
          state: 'opened'
        }
      },
      launchProjectEventAgent: (opened) => async (input) => {
        launches += 1
        bindForgeRunSession(opened.ledgerContext(), input.runId, 'claude_session-1')
        return {
          ok: true,
          mode: 'structured',
          sessionId: 'claude_session-1',
          promptOutcome: 'journaled'
        }
      }
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    expect(service.status().work.draining).toBe(true)
    expect(launches).toBe(0)
    expect(fx.rows('SELECT action_state FROM project_event_decisions')).toEqual([
      { action_state: 'queued' }
    ])
    ready()
    await service.settled()
    expect(launches).toBe(1)
    expect(fx.rows('SELECT action_state FROM project_event_decisions')).toEqual([
      { action_state: 'done' }
    ])
  })
})
