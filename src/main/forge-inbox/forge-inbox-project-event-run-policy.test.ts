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
import { ingestForgeEvent, queueForgeItemRun, queueForgeItemRunOutcome } from './forge-inbox-ingest'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem
} from './forge-inbox-project-event-action'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

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

const decision = (action: ProjectEventDecisionAction): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action,
  confidence: 0.8,
  probabilities: {
    record_only: 0.04,
    notify: 0.04,
    wait: 0.04,
    fetch_context: 0.04,
    dispatch_agent: action === 'dispatch_agent' ? 0.8 : 0.04,
    ask_user: 0.04
  },
  usage: { inputTokens: 10, outputTokens: 2 }
})

describe('project event binding runs carry the project event policy generation', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  let clock: number
  let deliveries: number
  let itemId: number

  function open(): ForgeLedgerContext {
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    return { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
  }

  function recordDispatch(): void {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${deliveries++}`,
      correlation: { eventUuid: null, configUuid: null },
      body: MR_BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const decisionClaim = claimProjectEventDecision(ctx)
    if (!decisionClaim) {
      throw new Error('expected a project event decision claim')
    }
    if (
      !decideProjectEventDelivery(
        ctx,
        admitted.deliveryId,
        decision('dispatch_agent'),
        decisionClaim
      ).ok
    ) {
      throw new Error('fixture could not record the decision')
    }
    const actionClaim = claimProjectEventAction(ctx, PROJECT_EVENT_DECISION_ACTIONS)
    if (!actionClaim) {
      throw new Error('expected a project event action claim')
    }
    const linked = linkProjectEventDecisionItem(ctx, actionClaim)
    if (!linked.ok) {
      throw new Error(`fixture could not link the item: ${linked.reason}`)
    }
    itemId = linked.itemId
  }

  function observeHead(token = 'sha256:observed-1'): void {
    ingestForgeEvent(ctx, {
      hostId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      projectId: 'group/demo',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: `obs-${token}`,
      eventKind: 'Merge Request Hook',
      versionToken: token,
      sourceOrder: 1,
      payload: { source: 'observed' }
    })
  }

  function runs(): unknown[] {
    return ctx.db.prepare('SELECT id, state, policy_generation FROM runs ORDER BY id').all()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-run-policy-'))
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
    recordDispatch()
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses an analysis of a webhook-reported head that nobody has verified', () => {
    // Paying here would analyse a snapshot the host never read back from GitLab (§5.2).
    expect(queueForgeItemRun(ctx, itemId, 'review')).toBeNull()
    expect(runs()).toEqual([])
  })

  it('distinguishes a missing head, a provisional head, and an already claimed head', () => {
    expect(queueForgeItemRunOutcome(ctx, 999, 'review')).toEqual({ kind: 'no-head' })
    expect(queueForgeItemRunOutcome(ctx, itemId, 'review')).toEqual({ kind: 'provisional-head' })

    observeHead()
    expect(queueForgeItemRunOutcome(ctx, itemId, 'review')).toEqual({ kind: 'queued', runId: 1 })
    expect(queueForgeItemRunOutcome(ctx, itemId, 'review')).toEqual({ kind: 'claimed' })
  })

  it('queues the run under the project event policy generation', () => {
    observeHead()

    expect(queueForgeItemRun(ctx, itemId, 'review')).toEqual(expect.any(Number))

    expect(runs()).toEqual([{ id: 1, state: 'queued', policy_generation: 1 }])
  })

  it('supersedes the queued run and re-queues it when the rules change', () => {
    observeHead()
    expect(queueForgeItemRun(ctx, itemId, 'review')).toEqual(expect.any(Number))

    expect(
      updateProjectEventPolicy(ctx, {
        repoId: REPO_ID,
        expectedGeneration: 1,
        patch: { rules: `${RULES}（修订）` }
      })
    ).toMatchObject({ ok: true, generation: 2 })

    expect(runs()).toEqual([{ id: 1, state: 'superseded', policy_generation: 1 }])
    expect(queueForgeItemRun(ctx, itemId, 'review')).toEqual(expect.any(Number))
    expect(runs()).toEqual([
      { id: 1, state: 'superseded', policy_generation: 1 },
      { id: 2, state: 'queued', policy_generation: 2 }
    ])
  })
})
