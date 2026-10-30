import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import Database from '../sqlite/sync-database'
import type { ForgeInboxLedger } from '../forge-inbox/forge-inbox-ledger'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  type WebhookHarness
} from '../forge-inbox/forge-inbox-webhook-test-harness'
import { createForgeDispatchedAgentCompletion } from './forge-dispatched-agent-completion'
import { createNotificationDeliveryService } from './notification-delivery-service'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/work/feature',
  workspaceKind: 'git-worktree'
} as const

let now = 1_000_000

describe('ordinary agent completion for a Forge dispatched agent', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let side: Database.Database

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger)
    side = new Database(harness.dbPath)
    const ingested = ledger.ingestEvent({
      hostId: 'host-a',
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'd1',
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
      .prepare(
        "UPDATE runs SET session_id = 'forge-session', terminal_handle = 'term-forge' WHERE id = ?"
      )
      .run(ingested.runId)
  })
  afterEach(() => {
    side.close()
    harness.dispose()
  })

  function setup(overrides: Partial<NotificationSettings> = {}, attached = true) {
    const settings: NotificationSettings = { ...getDefaultNotificationSettings(), ...overrides }
    const deliverNative = vi.fn(
      (_request: NotificationDispatchRequest) => ({ delivered: true }) as const
    )
    const dispatchMobileNotification = vi.fn()
    const service = createNotificationDeliveryService({
      readNotificationSettings: () => settings,
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: vi.fn(),
      isNotificationSupported: () => true,
      dispatchMobileNotification,
      readAuthorizationStatus: () => Promise.resolve('authorized'),
      recordDeliveryOutcome: vi.fn(),
      deliverNative,
      platform: 'linux',
      now: () => (now += 120_000),
      forgeDispatchedAgent: createForgeDispatchedAgentCompletion({
        forgeInbox: () => (attached ? ledger : null),
        terminalHandleForPaneKey: (paneKey) => (paneKey === 'tab-1:leaf-1' ? 'term-forge' : null)
      })
    })
    return { service, deliverNative, dispatchMobileNotification }
  }

  const structured = (
    sessionId: string,
    agentState: 'done' | 'blocked' = 'done'
  ): NotificationDispatchRequest => {
    const structuredOrigin: NotificationDispatchRequest['structuredOrigin'] = {
      scope: SCOPE,
      sessionId,
      cause: { kind: 'completion', requestId: `turn-${sessionId}` },
      journalCursor: { epoch: 'e', sequence: 1 }
    }
    return {
      source: 'agent-task-complete',
      surface: 'agent-session',
      worktreeId: SCOPE.workspaceId,
      agentState,
      structuredOrigin
    }
  }

  const terminal = (paneKey: string): NotificationDispatchRequest => ({
    source: 'agent-task-complete',
    worktreeId: SCOPE.workspaceId,
    paneKey,
    agentState: 'done'
  })

  it('stays off the desktop and phone lanes for a dispatched structured session', async () => {
    const { service, deliverNative, dispatchMobileNotification } = setup()

    expect(await service.dispatch(structured('forge-session'))).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
    expect(deliverNative).not.toHaveBeenCalled()
    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('stays off both lanes for the dispatched terminal pane', async () => {
    const { service, deliverNative, dispatchMobileNotification } = setup()

    expect((await service.dispatch(terminal('tab-1:leaf-1'))).delivered).toBe(false)
    expect(deliverNative).not.toHaveBeenCalled()
    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('still announces every unrelated ordinary completion', async () => {
    const { service, deliverNative, dispatchMobileNotification } = setup()

    expect((await service.dispatch(structured('someone-elses-session'))).delivered).toBe(true)
    expect((await service.dispatch(terminal('tab-2:leaf-2'))).delivered).toBe(true)
    expect(deliverNative).toHaveBeenCalledTimes(2)
    expect(dispatchMobileNotification).toHaveBeenCalledTimes(2)
  })

  it('keeps a dispatched agent that needs the user on the ordinary lane', async () => {
    const { service, deliverNative } = setup()

    expect((await service.dispatch(structured('forge-session', 'blocked'))).delivered).toBe(true)
    expect(deliverNative).toHaveBeenCalledTimes(1)
  })

  it('announces once, and only through the Forge preference, when a dispatched run completes', async () => {
    const forgeSuccess = {
      source: 'forge-inbox',
      notificationId: 'forge:owner:gitlab-main:1:run-succeeded:1',
      attentionKey: 'forge:owner:gitlab-main:1',
      forgeInbox: {
        subject: {
          ownerId: 'owner',
          instanceId: 'gitlab-main',
          itemId: 1,
          reason: 'run-succeeded',
          runId: 1
        },
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        title: 'Forge Inbox',
        body: 'fixed copy'
      }
    } satisfies NotificationDispatchRequest

    const quiet = setup()
    await quiet.service.dispatch(structured('forge-session'))
    await quiet.service.dispatch(forgeSuccess)
    expect(quiet.deliverNative).not.toHaveBeenCalled()

    const opted = setup({ forgeInboxCompletedRuns: true })
    await opted.service.dispatch(structured('forge-session'))
    await opted.service.dispatch(forgeSuccess)
    expect(opted.deliverNative).toHaveBeenCalledTimes(1)
    expect(opted.deliverNative.mock.calls[0]?.[0]).toMatchObject({ source: 'forge-inbox' })
  })

  it('never swallows an ordinary completion while no inbox is attached', async () => {
    const { service, deliverNative } = setup({}, false)

    expect((await service.dispatch(structured('forge-session'))).delivered).toBe(true)
    expect(deliverNative).toHaveBeenCalledTimes(1)
  })
})
