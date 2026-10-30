/**
 * Seeds one project event that the production owner service will dispatch to a real agent:
 * a bound project, an enabled policy, an admitted delivery, a `dispatch_agent` decision, and a
 * head observation so the dispatch needs no GitLab read of its own.
 *
 * Only the delivery's network provenance is authored here. Everything the app does with it —
 * decision drain, dispatch reservation, session launch, run settlement — is the shipped path.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FORGE_INBOX_LEDGER_FILE } from '../../../src/main/forge-inbox/forge-inbox-host-startup'
import type { ForgeLedgerContext } from '../../../src/main/forge-inbox/forge-inbox-context'
import { readForgeConfigState } from '../../../src/main/forge-inbox/forge-inbox-config'
import { ForgeInboxLedger } from '../../../src/main/forge-inbox/forge-inbox-ledger'
import { ingestForgeObservation } from '../../../src/main/forge-inbox/forge-inbox-observation'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from '../../../src/main/forge-inbox/forge-inbox-project-event-decision'
import { readForgeProjectInvalidationGeneration } from '../../../src/main/forge-inbox/forge-inbox-project-invalidation'
import { admitProjectEventDelivery } from '../../../src/main/forge-inbox/forge-inbox-project-event-delivery'
import { linkProjectEventBinding } from '../../../src/main/forge-inbox/forge-inbox-project-event-link'
import { updateProjectEventPolicy } from '../../../src/main/forge-inbox/forge-inbox-project-event-policy'
import { PROJECT_EVENT_REVISION_PREFIX } from '../../../src/main/forge-inbox/forge-inbox-project-event-revision'
import {
  BINDING_INSTANCE_PREFIX,
  upsertProjectBinding
} from '../../../src/main/forge-inbox/forge-inbox-project-binding'
import { fakeStore } from '../../../src/main/forge-inbox/forge-inbox-project-binding-test-fixture'
import { rowNumber } from '../../../src/main/forge-inbox/forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from '../../../src/main/forge-inbox/forge-inbox-webhook-queue'
import type { ProjectEventDecisionResult } from '../../../src/shared/project-event-decision'

export const REAL_AGENT_ITEM = {
  gitlabPath: 'group/agent-demo',
  gitlabProjectId: 41,
  iid: 12,
  title: 'Retitle the demo page heading'
} as const

export type SeededRealAgentDispatch = {
  itemId: number
  deliveryId: number
  itemTitle: string
  projectPath: string
}

const RULES = 'Reply in one short sentence describing the change this request asks for.'

/** The same shape the decision source records, so the drain reads a real decision row. */
function dispatchDecision(): ProjectEventDecisionResult {
  return {
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
}

function mergeRequestBody(sha: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      object_kind: 'merge_request',
      project: {
        id: REAL_AGENT_ITEM.gitlabProjectId,
        path_with_namespace: REAL_AGENT_ITEM.gitlabPath
      },
      merge_request: { iid: REAL_AGENT_ITEM.iid, title: REAL_AGENT_ITEM.title, state: 'opened' },
      object_attributes: { action: 'update', last_commit: { id: sha } }
    })
  )
}

/** Head facts as an authenticated read would report them; no provisional token is left behind. */
function recordObservedHead(ctx: ForgeLedgerContext, sha: string): void {
  const itemKey = {
    hostId: ctx.hostId,
    instanceId: `${BINDING_INSTANCE_PREFIX}gitlab.test`,
    projectId: REAL_AGENT_ITEM.gitlabPath,
    kind: 'merge_request' as const,
    iid: REAL_AGENT_ITEM.iid
  }
  const result = ingestForgeObservation(
    ctx,
    {
      ...itemKey,
      dedupeKey: `e2e-observe-${randomUUID()}`,
      eventKind: 'Merge Request Hook',
      versionToken: `${PROJECT_EVENT_REVISION_PREFIX}${sha}`,
      payload: {
        source: 'observed',
        category: 'review-request',
        completeness: { complete: true },
        sha,
        title: REAL_AGENT_ITEM.title,
        state: 'opened'
      },
      title: REAL_AGENT_ITEM.title,
      itemState: 'opened'
    },
    readForgeConfigState(ctx).revision,
    readForgeProjectInvalidationGeneration(ctx, itemKey)
  )
  if (!result.ok) {
    throw new Error(`the seeded observation was refused: ${result.reason}`)
  }
}

export async function seedRealAgentDispatch(
  profileDir: string,
  input: { repoPath: string; repoId: string }
): Promise<SeededRealAgentDispatch> {
  const ledger = ForgeInboxLedger.open(join(profileDir, FORGE_INBOX_LEDGER_FILE), {
    now: () => Date.now(),
    secretStore: fakeStore()
  })
  try {
    const ctx = ledger.ledgerContext()
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: input.repoPath,
      gitlabHost: 'gitlab.test',
      gitlabPath: REAL_AGENT_ITEM.gitlabPath,
      gitlabProjectId: REAL_AGENT_ITEM.gitlabProjectId,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx, { repoId: input.repoId, bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: input.repoId,
      expectedGeneration: 0,
      patch: { enabled: true, agentId: 'claude', model: 'claude-sonnet-5-5', rules: RULES }
    })
    const sha = 'c'.repeat(40)
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: REAL_AGENT_ITEM.gitlabPath,
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `e2e-real-agent-${randomUUID()}`,
      correlation: { eventUuid: null, configUuid: null },
      body: mergeRequestBody(sha)
    })
    if (!admitted.ok) {
      throw new Error(`the seeded delivery was not admitted: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      throw new Error('the seeded delivery was not claimed for a decision')
    }
    const decided = decideProjectEventDelivery(ctx, admitted.deliveryId, dispatchDecision(), claim)
    if (!decided.ok) {
      throw new Error(`the seeded decision was refused: ${decided.reason}`)
    }
    // A webhook alone is provisional; the dispatch would need a live GitLab read without this.
    recordObservedHead(ctx, sha)
    const head = ctx.db
      .prepare('SELECT id FROM items WHERE instance_id = ? ORDER BY id DESC LIMIT 1')
      .get(`${BINDING_INSTANCE_PREFIX}gitlab.test`)
    if (!head) {
      throw new Error('the seeded item is missing after its decision')
    }
    return {
      itemId: rowNumber(head, 'id'),
      deliveryId: admitted.deliveryId,
      itemTitle: REAL_AGENT_ITEM.title,
      projectPath: REAL_AGENT_ITEM.gitlabPath
    }
  } finally {
    ledger.close()
  }
}
