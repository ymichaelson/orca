/**
 * Seeds one item per GitLab project into a profile's forge ledger, so the Inbox can be narrowed by
 * project or by the state the host derives for each item. Every delivery takes a real decision path:
 * `notify` settles without a launch, `ask_user` runs the real preparation drain (which fails the
 * launch in a profile with no repo, so that item derives `failed`), and a hook-only item stays
 * `recorded`.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ForgeLedgerContext } from '../../../src/main/forge-inbox/forge-inbox-context'
import { FORGE_INBOX_LEDGER_FILE } from '../../../src/main/forge-inbox/forge-inbox-host-startup'
import { ForgeInboxLedger } from '../../../src/main/forge-inbox/forge-inbox-ledger'
import { admitProjectEventDelivery } from '../../../src/main/forge-inbox/forge-inbox-project-event-delivery'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from '../../../src/main/forge-inbox/forge-inbox-project-event-decision'
import { projectEventQuestionDecision } from '../../../src/main/forge-inbox/forge-inbox-project-event-question-test-kit'
import { openQuestionPreparationHarness } from '../../../src/main/forge-inbox/forge-inbox-project-event-question-preparation-test-kit'
import {
  claimProjectEventAction,
  linkProjectEventDecisionItem
} from '../../../src/main/forge-inbox/forge-inbox-project-event-action'
import { settleProjectEventAction } from '../../../src/main/forge-inbox/forge-inbox-project-event-action-settle'
import { linkProjectEventBinding } from '../../../src/main/forge-inbox/forge-inbox-project-event-link'
import { updateProjectEventPolicy } from '../../../src/main/forge-inbox/forge-inbox-project-event-policy'
import { upsertProjectBinding } from '../../../src/main/forge-inbox/forge-inbox-project-binding'
import { fakeStore } from '../../../src/main/forge-inbox/forge-inbox-project-binding-test-fixture'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from '../../../src/main/forge-inbox/forge-inbox-webhook-queue'

export type SeededProjectItem = {
  projectPath: string
  title: string
  /** True for the item the host derives `failed` for; the others are `done` or `recorded`. */
  failed?: boolean
}

/** One hook-only item, so the list holds a state no question reached: recorded. */
const RECORDED_ITEM = { projectPath: 'group/demo', iid: 9, title: 'Docs change' }

const PROJECTS = [
  {
    gitlabPath: 'group/demo',
    gitlabProjectId: 3,
    repoId: 'repo-demo',
    iid: 7,
    title: 'Add thing',
    action: 'notify'
  },
  {
    gitlabPath: 'other/tool',
    gitlabProjectId: 4,
    repoId: 'repo-tool',
    iid: 8,
    title: 'Fix pipeline',
    action: 'ask_user'
  }
] as const

function mergeRequestBody(project: (typeof PROJECTS)[number]): Buffer {
  return Buffer.from(
    JSON.stringify({
      object_kind: 'merge_request',
      project: { id: project.gitlabProjectId, path_with_namespace: project.gitlabPath },
      merge_request: { iid: project.iid, title: project.title, state: 'opened' },
      object_attributes: { action: 'update', last_commit: { id: `sha-${project.iid}` } }
    })
  )
}

/** A `notify` decision still creates the item, and settles as handled without any launch. */
function settleWithoutLaunch(ctx: ForgeLedgerContext): void {
  const claim = claimProjectEventAction(ctx)
  if (!claim) {
    throw new Error('the seeded action was not claimed')
  }
  const linked = linkProjectEventDecisionItem(ctx, claim)
  if (!linked.ok) {
    throw new Error(`could not link the seeded item: ${linked.reason}`)
  }
  const settled = settleProjectEventAction(ctx, claim, { kind: 'done' })
  if (!settled.ok) {
    throw new Error('could not settle the seeded notify action')
  }
}

export async function seedProjectEventItems(profileDir: string): Promise<SeededProjectItem[]> {
  // Why: the app adopts the persisted owner, so a seeded ledger has to be openable by it.
  const ledger = ForgeInboxLedger.open(join(profileDir, FORGE_INBOX_LEDGER_FILE), {
    now: () => Date.now(),
    secretStore: fakeStore()
  })
  try {
    const ctx = ledger.ledgerContext()
    for (const project of PROJECTS) {
      const bindingId = randomUUID()
      upsertProjectBinding(ctx, {
        bindingId,
        projectPath: `/work/${project.repoId}`,
        gitlabHost: 'gitlab.test',
        gitlabPath: project.gitlabPath,
        gitlabProjectId: project.gitlabProjectId,
        callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
      })
      linkProjectEventBinding(ctx, { repoId: project.repoId, bindingId })
      updateProjectEventPolicy(ctx, {
        repoId: project.repoId,
        expectedGeneration: 0,
        patch: { enabled: true, agentId: 'claude', model: 'claude-sonnet-5-5', rules: 'rules' }
      })
      const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
        bindingId,
        projectPath: project.gitlabPath,
        policyGeneration: 1,
        policyEnabled: true,
        eventKind: 'Merge Request Hook',
        dedupeKey: `e2e-project-${randomUUID()}`,
        correlation: { eventUuid: null, configUuid: null },
        body: mergeRequestBody(project)
      })
      if (!admitted.ok) {
        throw new Error(`could not admit the seeded delivery: ${admitted.reason}`)
      }
      const claim = claimProjectEventDecision(ctx)
      if (!claim) {
        throw new Error('the seeded delivery was not decided')
      }
      const decided = decideProjectEventDelivery(
        ctx,
        admitted.deliveryId,
        projectEventQuestionDecision(project.action),
        claim
      )
      if (!decided.ok) {
        throw new Error(`could not record the ${project.action} decision: ${decided.reason}`)
      }
      if (project.action === 'notify') {
        settleWithoutLaunch(ctx)
        continue
      }
      const question = `What should happen with ${project.title}?`
      const harness = openQuestionPreparationHarness(ledger, { question })
      try {
        const drained = await harness.drain()
        if (drained.executed !== 1 || drained.failed !== 0) {
          throw new Error(`the seeded question was not published: ${JSON.stringify(drained)}`)
        }
        await harness.complete()
      } finally {
        harness.dispose()
      }
    }
    const recorded = ledger.ingestEvent({
      hostId: ctx.hostId,
      instanceId: 'gitlab:gitlab.test',
      projectId: RECORDED_ITEM.projectPath,
      kind: 'merge_request',
      iid: RECORDED_ITEM.iid,
      dedupeKey: `e2e-recorded-${randomUUID()}`,
      eventKind: 'Merge Request Hook',
      payload: { category: 'review-request', completeness: { complete: true } },
      versionToken: `e2e-${RECORDED_ITEM.iid}`,
      sourceOrder: 1,
      title: RECORDED_ITEM.title,
      itemState: 'opened'
    })
    if (recorded.duplicate) {
      throw new Error('the recorded seed item was not new')
    }
    const projects = ctx.db
      .prepare('SELECT DISTINCT project_id FROM items ORDER BY project_id')
      .all()
      .map((row) => String(row.project_id))
    if (projects.length !== PROJECTS.length) {
      const deliveries = ctx.db
        .prepare('SELECT id, state, decision_state, last_error_code FROM webhook_deliveries')
        .all()
      throw new Error(
        `expected one item per project, got ${JSON.stringify(projects)}; deliveries ${JSON.stringify(deliveries)}`
      )
    }
    return [
      ...PROJECTS.map((project) => ({
        projectPath: project.gitlabPath,
        title: project.title,
        ...(project.action === 'ask_user' ? { failed: true as const } : {})
      })),
      { projectPath: RECORDED_ITEM.projectPath, title: RECORDED_ITEM.title }
    ]
  } finally {
    ledger.close()
  }
}
