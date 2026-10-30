import type * as RegistryModule from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { createForgeProjectEventRunHostWatch } from './forge-inbox-project-event-run-host-watch'
import {
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', async (original) => {
  const actual = await original<typeof RegistryModule>()
  return { ...actual, getStructuredAgentSessionHost: vi.fn(actual.getStructuredAgentSessionHost) }
})

const SCOPE = { instanceId: 'gitlab:gitlab.test' }
const SESSION = 'structured-claude-1'
const SEND = 'send-1'

describe('project event run host watch', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    vi.useFakeTimers()
    harness = createWebhookHarness()
    ledger = harness.open()
  })
  afterEach(() => {
    vi.useRealTimers()
    setStructuredAgentSessionHost(null)
    harness.dispose()
  })

  let nextIid = 7

  function runningRun(sessionId: string | null = SESSION): number {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: 'group/project',
        kind: 'merge_request',
        iid: nextIid++,
        dedupeKey: `d-${nextIid}`,
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: 'sha256:v1',
        queueRun: { reason: 'project-event-dispatch' }
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!observed.ok || observed.duplicate || observed.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(observed)}`)
    }
    const ctx = ledger.ledgerContext()
    if (!transitionForgeRun(ctx, observed.runId, { to: 'running' }).ok) {
      throw new Error('run did not start')
    }
    if (sessionId !== null && !bindForgeRunSession(ctx, observed.runId, sessionId)) {
      throw new Error('session did not bind')
    }
    bindForgeRunDispatchTurn(ctx, observed.runId, SEND)
    return observed.runId
  }

  function stubHost(): { host: StructuredAgentSessionHost; unsubscribed: () => number } {
    let unsubscribed = 0
    const host = {
      subscribeTurnCompletions: () => () => {
        unsubscribed += 1
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only subscribeTurnCompletions from the registered host.
    return { host: host as unknown as StructuredAgentSessionHost, unsubscribed: () => unsubscribed }
  }

  it('hands a running run to recovery and detaches the old feed when the host is replaced', () => {
    const first = stubHost()
    setStructuredAgentSessionHost(first.host)
    const runId = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runId, SEND)

    setStructuredAgentSessionHost(stubHost().host)

    expect(first.unsubscribed()).toBe(1)
    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome',
      sessionId: SESSION
    })
    watch.dispose()
  })

  it('marks running runs unverifiable when disposed', () => {
    const first = stubHost()
    setStructuredAgentSessionHost(first.host)
    const runId = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runId, SEND)

    watch.dispose()

    expect(first.unsubscribed()).toBe(1)
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('unverifiable')
  })

  function listeningHost() {
    let subscriptions = 0
    let histories = 0
    const feed: { emit?: (event: AgentSessionTurnCompletionEvent) => void } = {}
    const host = {
      subscribeTurnCompletions: (subscriber: {
        emit: (event: AgentSessionTurnCompletionEvent) => void
      }) => {
        subscriptions += 1
        feed.emit = subscriber.emit
        return () => undefined
      },
      history: async () => {
        histories += 1
        return { ok: false }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only subscribeTurnCompletions and history from the registered host.
    const typed = host as unknown as StructuredAgentSessionHost
    return { host: typed, feed, subscriptions: () => subscriptions, histories: () => histories }
  }

  const settleAsync = () => vi.advanceTimersByTimeAsync(10)
  const registryReads = () => vi.mocked(getStructuredAgentSessionHost).mock.calls.length

  function completion(sessionId: string): AgentSessionTurnCompletionEvent {
    return {
      type: 'completion',
      completion: {
        scope: {
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          wslDistro: null,
          workspaceId: 'ws-1',
          workspaceKind: 'git-worktree'
        },
        sessionId,
        turnId: 'turn-1',
        outcome: 'success',
        completedAt: 1
      }
    }
  }

  it('registers nothing for a launcher that never watched a send', async () => {
    setStructuredAgentSessionHost(stubHost().host)
    const runId = runningRun()
    transitionForgeRun(ledger.ledgerContext(), runId, {
      to: 'unverifiable',
      error: 'unknown-outcome'
    })
    const next = listeningHost()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    const before = registryReads()

    setStructuredAgentSessionHost(next.host)
    await settleAsync()

    expect(next.histories()).toBe(0)
    expect(registryReads()).toBe(before)
    watch.dispose()
  })

  it('watches a still-unproven run on the replacement host and settles it from that feed', async () => {
    setStructuredAgentSessionHost(stubHost().host)
    const runId = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runId, SEND)
    const next = listeningHost()

    setStructuredAgentSessionHost(next.host)
    await settleAsync()
    const afterRecovery = next.histories()
    next.feed.emit?.(completion(SESSION))
    await settleAsync()

    expect(next.subscriptions()).toBe(1)
    expect(next.histories()).toBeGreaterThan(afterRecovery)
    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
    watch.dispose()
  })

  it('stops listening to the registry once its ledger is closed', async () => {
    setStructuredAgentSessionHost(stubHost().host)
    const runId = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runId, SEND)
    ledger.close()
    const next = listeningHost()

    setStructuredAgentSessionHost(next.host)
    await settleAsync()
    const afterClosedChange = registryReads()
    setStructuredAgentSessionHost(listeningHost().host)
    await settleAsync()

    expect(next.subscriptions()).toBe(0)
    expect(registryReads()).toBe(afterClosedChange)
  })

  it('stops listening to the registry once disposed', async () => {
    setStructuredAgentSessionHost(stubHost().host)
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runningRun(), SEND)
    watch.dispose()
    const before = registryReads()

    setStructuredAgentSessionHost(listeningHost().host)
    await settleAsync()

    expect(registryReads()).toBe(before)
  })

  it('ignores a send watched after its ledger closed', () => {
    const host = listeningHost()
    setStructuredAgentSessionHost(host.host)
    const runId = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, runId, SEND)
    ledger.close()

    watch.watch('structured-claude-2', runId, SEND)

    expect(watch.isDisposed()).toBe(true)
  })

  it('builds a fresh inner watch after the feed ended on its own', () => {
    const host = listeningHost()
    setStructuredAgentSessionHost(host.host)
    const first = runningRun()
    const watch = createForgeProjectEventRunHostWatch(ledger)
    watch.watch(SESSION, first, SEND)
    host.feed.emit?.({ type: 'end' })
    const second = runningRun('structured-claude-2')

    watch.watch('structured-claude-2', second, SEND)
    watch.dispose()

    expect(readForgeRun(ledger.ledgerContext(), second)?.state).toBe('unverifiable')
  })
})
