import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from '../forge-inbox/forge-inbox-ledger'
import { createForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from '../forge-inbox/forge-inbox-webhook-test-harness'
import type { StatusRowMutationListener } from '../agent-hooks/server/server-types'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import { OrcaRuntimeService } from './orca-runtime'

const SESSION = 'forge-session'
const WORKTREE_ID = 'repo-1::/tmp/wt-a'
const OTHER_WORKTREE_ID = 'repo-1::/tmp/wt-b'
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB = 'tab-2'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey(TAB, LEAF)
const OTHER_PANE = makePaneKey(OTHER_TAB, OTHER_LEAF)

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/wt-a',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: 'local'
      }
    ]),
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

/** A headless host with one dispatched pane and one unrelated pane, both real runtime terminals. */
function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns the reads this suite drives; the rest of Store is unreached.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [
      { tabId: TAB, worktreeId: WORKTREE_ID, title: 'shell', activeLeafId: LEAF, layout: null },
      {
        tabId: OTHER_TAB,
        worktreeId: OTHER_WORKTREE_ID,
        title: 'shell',
        activeLeafId: OTHER_LEAF,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB,
        worktreeId: WORKTREE_ID,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-dispatched',
        paneTitle: null
      },
      {
        tabId: OTHER_TAB,
        worktreeId: OTHER_WORKTREE_ID,
        leafId: OTHER_LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-unrelated',
        paneTitle: null
      }
    ]
  })
  return runtime
}

function agentRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'done',
    prompt: 'fix the bug',
    agentType: 'claude',
    paneKey: PANE,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 5_000,
    lastAssistantMessage: 'Fixed it.',
    ...overrides
  }
}

describe('forge dispatched-agent ownership at the runtime construction boundary', () => {
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

  function seedDispatchedRun(hostHandle: string): void {
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
    side
      .prepare('UPDATE runs SET session_id = ?, terminal_handle = ? WHERE id = ?')
      .run(SESSION, hostHandle, ingested.runId)
  }

  async function attachRealOwner(runtime: OrcaRuntimeService): Promise<void> {
    await owner.start()
    runtime.attachForgeInboxService(owner)
  }

  it('defers the dispatch that started the session, and only a done one', async () => {
    const runtime = makeRuntime()
    seedDispatchedRun(runtime.getTerminalHandleForPaneKey(PANE) ?? 'term-missing')
    await attachRealOwner(runtime)

    const completion = runtime.forgeDispatchedAgentCompletion()
    expect(completion.defersToForge({ state: 'done', sessionId: SESSION })).toBe(true)
    // Needs-user stays on the ordinary lane: Forge reports it as its own verdict.
    expect(completion.defersToForge({ state: 'blocked', sessionId: SESSION })).toBe(false)
    expect(completion.defersToForge({ state: 'done', sessionId: 'someone-elses' })).toBe(false)
  })

  it('defers a done pane whose terminal handle the runtime really resolves', async () => {
    const runtime = makeRuntime()
    const handle = runtime.getTerminalHandleForPaneKey(PANE)
    if (handle === null) {
      throw new Error('the fixture pane has no runtime terminal handle')
    }
    seedDispatchedRun(handle)
    await attachRealOwner(runtime)

    const completion = runtime.forgeDispatchedAgentCompletion()
    expect(runtime.getTerminalHandleForPaneKey(PANE)).toBe(handle)
    expect(completion.defersToForge({ state: 'done', paneKey: PANE })).toBe(true)
    expect(completion.defersToForge({ state: 'done', paneKey: OTHER_PANE })).toBe(false)
  })

  it('never swallows an ordinary completion while no inbox is attached', () => {
    const runtime = makeRuntime()

    expect(
      runtime.forgeDispatchedAgentCompletion().defersToForge({ state: 'done', sessionId: SESSION })
    ).toBe(false)
    expect(
      runtime.forgeDispatchedAgentCompletion().defersToForge({ state: 'done', paneKey: PANE })
    ).toBe(false)
  })

  /** Drives the runtime's own detector the way the hook server does, to a finished turn. */
  function finishTurn(
    runtime: OrcaRuntimeService,
    row: AgentStatusIpcPayload,
    workingRow: AgentStatusIpcPayload
  ): void {
    const rows = new Map<string, AgentStatusIpcPayload>()
    let mutated: StatusRowMutationListener | null = null
    runtime.attachAgentStatusStore({
      getStatusSnapshot: () => [...rows.values()],
      getStatusSnapshotForPane: (paneKey) => (rows.has(paneKey) ? [rows.get(paneKey)!] : []),
      subscribeStatusRowMutations: (listener) => {
        mutated = listener
        return () => {
          mutated = null
        }
      },
      subscribeStatusFreshness: () => () => {}
    })
    const report = (next: AgentStatusIpcPayload): void => {
      rows.set(next.paneKey, next)
      mutated?.({ before: null, after: next })
    }
    vi.useFakeTimers()
    try {
      report(workingRow)
      report(row)
      vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    } finally {
      vi.useRealTimers()
    }
  }

  it('keeps the host phone push for a dispatched terminal off', async () => {
    const runtime = makeRuntime()
    seedDispatchedRun(runtime.getTerminalHandleForPaneKey(PANE) ?? 'term-missing')
    await attachRealOwner(runtime)
    const events: MobileNotificationEvent[] = []
    runtime.onNotificationDispatched((event) => events.push(event))

    finishTurn(runtime, agentRow(), agentRow({ state: 'working' }))

    expect(events).toEqual([])
  })

  it('still pushes an unrelated terminal finish', async () => {
    const runtime = makeRuntime()
    seedDispatchedRun(runtime.getTerminalHandleForPaneKey(PANE) ?? 'term-missing')
    await attachRealOwner(runtime)
    const events: MobileNotificationEvent[] = []
    runtime.onNotificationDispatched((event) => events.push(event))
    const unrelated = { paneKey: OTHER_PANE, worktreeId: OTHER_WORKTREE_ID }

    finishTurn(
      runtime,
      agentRow({ ...unrelated, stateStartedAt: 6_000 }),
      agentRow({ ...unrelated, state: 'working' })
    )

    expect(events).toEqual([
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: OTHER_WORKTREE_ID,
        notificationId: buildAgentNotificationId({
          worktreeId: OTHER_WORKTREE_ID,
          paneKey: OTHER_PANE,
          stateStartedAt: 6_000
        })
      })
    ])
  })
})
