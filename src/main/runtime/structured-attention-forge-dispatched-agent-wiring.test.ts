import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../shared/agent-session-attention'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from '../forge-inbox/forge-inbox-ledger'
import { createForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from '../forge-inbox/forge-inbox-webhook-test-harness'

const installed: { deps: Record<string, unknown> | null } = vi.hoisted(() => ({ deps: null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

vi.mock('./structured-agent-session-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredAgentSessionRuntime>()
  return {
    ...actual,
    ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
      installed.deps = deps
    })
  }
})

import type { StructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type * as StructuredAgentSessionRuntime from './structured-agent-session-runtime'
import { OrcaRuntimeService } from './orca-runtime'

const SESSION = 'forge-session'
const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/work/feature',
  workspaceKind: 'git-worktree'
} as const

const SUMMARY: AgentSessionStatusSummary = {
  sessionId: SESSION,
  workspaceId: SCOPE.workspaceId,
  agent: 'claude',
  status: 'idle',
  latestPrompt: 'Ship it',
  lastAssistantMessage: 'Shipped.',
  updatedAt: 1
}

function completion(sessionId: string): AgentSessionAttentionEdge {
  return {
    type: 'completion',
    completion: {
      scope: SCOPE,
      sessionId,
      turnId: `turn-${sessionId}`,
      outcome: 'success',
      completedAt: 1
    }
  }
}

const PROMPT: AgentSessionAttentionEdge = {
  type: 'prompt',
  prompt: { scope: SCOPE, sessionId: SESSION, promptId: 'approval-1', raisedAt: 1 }
}

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => []),
    getRepo: vi.fn(() => undefined),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getSettings: vi.fn(() => ({
      notifications: getDefaultNotificationSettings(),
      workspaceDir: '/tmp/workspaces'
    })),
    getProjects: vi.fn(() => [])
  }
}

describe('structured-chat phone attention for a Forge dispatched agent', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let side: Database.Database
  let owner: ReturnType<typeof createForgeInboxOwnerService>

  beforeEach(async () => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
    side = new Database(harness.dbPath)
    owner = createForgeInboxOwnerService({
      dbPath: harness.dbPath,
      secretStore: harness.store,
      http: { fetch: () => Promise.reject(new Error('no network in tests')) }
    })
  })

  afterEach(async () => {
    await owner.stop()
    side.close()
    harness.dispose()
  })

  function seedDispatchedSession(sessionId: string): void {
    const ingested = ledger.ingestEvent({
      hostId: 'host-a',
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'd-dispatch',
      eventKind: 'merge_request.updated',
      payload: { n: 1 },
      versionToken: 'v1',
      sourceOrder: 1,
      title: 'Add thing',
      itemState: 'opened',
      queueRun: { reason: 'project-event-dispatch' }
    })
    if (ingested.duplicate || ingested.runId === null) {
      throw new Error('no run queued')
    }
    side.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, ingested.runId)
  }

  async function constructedDelivery(): Promise<{
    runtime: OrcaRuntimeService
    delivery: StructuredAttentionMobileDelivery
    events: MobileNotificationEvent[]
  }> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns the reads this suite drives; the rest of Store is unreached.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    await owner.start()
    runtime.attachForgeInboxService(owner)
    await runtime.ensureStructuredAgentSessionHost()
    const delivery = installed.deps?.['attentionDelivery']
    if (!delivery) {
      throw new Error('the runtime installed no structured attention delivery')
    }
    const events: MobileNotificationEvent[] = []
    runtime.onNotificationDispatched((event) => events.push(event))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ensureStructuredAgentSessionHost receives the delivery this runtime constructed, typed by the host options.
    return { runtime, delivery: delivery as StructuredAttentionMobileDelivery, events }
  }

  it('leaves a dispatched session’s finish to Forge but keeps its prompts and unrelated finishes', async () => {
    seedDispatchedSession(SESSION)
    const { delivery, events } = await constructedDelivery()

    delivery.deliver(completion(SESSION), SUMMARY)
    expect(events).toEqual([])

    delivery.deliver(completion('someone-elses-session'), {
      ...SUMMARY,
      sessionId: 'someone-elses-session'
    })
    expect(events.map((event) => event.type === 'notification' && event.agentState)).toEqual([
      'done'
    ])
  })

  it('keeps a dispatched session’s prompt on the ordinary needs-input lane', async () => {
    seedDispatchedSession(SESSION)
    const { delivery, events } = await constructedDelivery()

    delivery.deliver(PROMPT, SUMMARY)
    expect(events.map((event) => event.type === 'notification' && event.agentState)).toEqual([
      'blocked'
    ])
  })

  it('reconciles withdrawals through the runtime’s own controller', async () => {
    seedDispatchedSession(SESSION)
    const { delivery } = await constructedDelivery()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reconcile state this host never sent is a no-op either way.
    const state = {
      scope: SCOPE,
      sessionId: SESSION,
      pendingPromptIds: []
    } as StructuredAttentionState
    expect(() => delivery.reconcile(state)).not.toThrow()
  })
})
