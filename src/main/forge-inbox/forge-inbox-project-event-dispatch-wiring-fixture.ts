import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import type {
  ProjectEventAgentLaunchPorts,
  ProjectEventStructuredSessionCreate
} from './forge-inbox-project-event-agent-launch'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { rowNumber } from './forge-inbox-rows'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

export const REPO_ID = 'repo-1'
export const WORKSPACE_ID = 'repo-1::/work/repo'
const MODEL = 'claude-sonnet-5-5'
const MR_BODY = Buffer.from(
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 3 },
    merge_request: { iid: 7, title: 'Add thing', state: 'opened' },
    object_attributes: { action: 'update', last_commit: { id: 'sha-1' } }
  })
)

export type WiringProbe = {
  created: Parameters<ProjectEventStructuredSessionCreate>[0][]
  delivered: { callerKey: string; sessionId: string; fence: number; text: string }[]
}

export type DispatchWiringFixture = {
  ledger: ForgeInboxLedger
  bindingId: string
  ctx: () => ForgeLedgerContext
  record: (action: ProjectEventDecisionAction) => number
  observe: (sha?: string) => () => Promise<ProjectEventHeadObservation>
  wiringProbe: () => WiringProbe
  launchPorts: (
    probe: WiringProbe,
    refusal?: { code: string; message: string }
  ) => ProjectEventAgentLaunchPorts
  decisionRow: () => Record<string, unknown>
  deliveryRow: (id: number) => Record<string, unknown>
  runs: () => Record<string, unknown>[]
  close: () => void
}

/** A real ledger with one bound, policy-enabled project; every helper acts on the same host. */
export function openDispatchWiringFixture(): DispatchWiringFixture {
  const root = mkdtempSync(join(tmpdir(), 'forge-dispatch-wiring-'))
  let clock = 1000
  const ledger = ForgeInboxLedger.open(join(root, 'forge-inbox.sqlite'), {
    hostId: 'host-1',
    now: () => ++clock,
    secretStore: fakeStore()
  })
  const bindingId = randomUUID()
  const ctx = () => ledger.ledgerContext()

  upsertProjectBinding(ctx(), {
    bindingId,
    projectPath: '/repo',
    gitlabHost: 'gitlab.test',
    gitlabPath: 'group/demo',
    gitlabProjectId: 3,
    callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
  })
  linkProjectEventBinding(ctx(), { repoId: REPO_ID, bindingId })
  updateProjectEventPolicy(ctx(), {
    repoId: REPO_ID,
    expectedGeneration: 0,
    patch: { enabled: true, agentId: 'claude', model: MODEL, rules: 'rules' }
  })

  function admit(action: ProjectEventDecisionAction): number {
    const admitted = admitProjectEventDelivery(ctx(), FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: `delivery-${randomUUID()}`,
      correlation: { eventUuid: null, configUuid: null },
      body: MR_BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
    const decision = claimProjectEventDecision(ctx())
    if (!decision) {
      throw new Error('expected a project event decision claim')
    }
    const result = decideProjectEventDelivery(
      ctx(),
      admitted.deliveryId,
      decisionFor(action),
      decision
    )
    if (!result.ok) {
      throw new Error('fixture could not record the decision')
    }
    return admitted.deliveryId
  }

  function observe(sha?: string): () => Promise<ProjectEventHeadObservation> {
    return async () => {
      const head = ctx()
        .db.prepare('SELECT id, current_revision FROM items ORDER BY id LIMIT 1')
        .get()
      if (!head) {
        throw new Error('expected the admitted item')
      }
      const itemId = rowNumber(head, 'id')
      const revision = rowNumber(head, 'current_revision') + 1
      ctx()
        .db.prepare(`INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
        VALUES (?, ?, 'sha256:observed', ?, ?)`)
        .run(itemId, revision, revision, ctx().now())
      ctx()
        .db.prepare('UPDATE items SET current_revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, ctx().now(), itemId)
      if (sha !== undefined) {
        ctx()
          .db.prepare(`INSERT INTO events (item_id, revision, event_kind, version_token, source_order,
          payload_json, received_at) VALUES (?, ?, 'Merge Request Hook', 'sha256:observed', ?, ?, ?)`)
          .run(itemId, revision, revision, JSON.stringify({ sha }), ctx().now())
      }
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
    }
  }

  function launchPorts(
    probe: WiringProbe,
    refusal?: { code: string; message: string }
  ): ProjectEventAgentLaunchPorts {
    return {
      runtime: {
        requireStore: () => ({
          getSettings: () => ({ experimentalNativeChat: true }),
          getRepo: () => ({ path: '/work/repo', connectionId: null })
        }),
        getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
        ensureStructuredAgentSessionHost: async () => {},
        launchAgentTerminal: async () => {
          throw new Error('dispatch must keep its structured surface')
        },
        resolveRuntimeFileTarget: async () => ({
          worktree: { path: '/work/repo', id: WORKSPACE_ID, repoId: REPO_ID },
          executionHostId: LOCAL_EXECUTION_HOST_ID
        })
      },
      createStructuredSession: async (args) => {
        probe.created.push(args)
        return refusal
          ? { ok: false, refusal }
          : { ok: true, value: { sessionId: args.envelope.sessionId, fence: 4 } }
      },
      deliverStructuredPrompt: async (args) => {
        probe.delivered.push(args)
        return 'message-1'
      }
    }
  }

  function decisionRow(): Record<string, unknown> {
    const row = ctx()
      .db.prepare(
        'SELECT action_state, run_id, last_error_code FROM project_event_decisions ORDER BY id DESC LIMIT 1'
      )
      .get()
    if (!row) {
      throw new Error('expected a decision')
    }
    return row
  }

  function deliveryRow(id: number): Record<string, unknown> {
    const row = ctx()
      .db.prepare('SELECT state, last_error_code FROM webhook_deliveries WHERE id = ?')
      .get(id)
    if (!row) {
      throw new Error('expected a delivery')
    }
    return row
  }

  const runs = () =>
    ctx().db.prepare('SELECT state, reason, session_id, error FROM runs ORDER BY id').all()

  return {
    ledger,
    bindingId,
    ctx,
    record: admit,
    observe,
    wiringProbe: () => ({ created: [], delivered: [] }),
    launchPorts,
    decisionRow,
    deliveryRow,
    runs,
    close: () => {
      ledger.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

export function decisionFor(action: ProjectEventDecisionAction) {
  return {
    ok: true as const,
    provider: 'jev' as const,
    model: 'jev-1',
    action,
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
