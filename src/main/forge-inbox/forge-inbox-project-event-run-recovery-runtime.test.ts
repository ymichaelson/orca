import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  protectedTurnHarness,
  protectedTurnJournal,
  TURN_SESSION
} from './forge-inbox-protected-turn-test-harness'
import {
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { forgeInboxProjectEventRunRecoveryForRuntime } =
  await import('./forge-inbox-project-event-run-recovery-runtime')

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

describe('project event run recovery runtime', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let nextIid = 7

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
  })
  afterEach(() => {
    vi.useRealTimers()
    hostRef.current = null
    harness.dispose()
  })

  /** A run whose process died after dispatch: the state a restart must reconcile. */
  function interruptedRun(clientMessageId: string): number {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: 'group/project',
        kind: 'merge_request',
        iid: nextIid++,
        dedupeKey: `d-${Math.random()}`,
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
    if (!bindForgeRunSession(ctx, observed.runId, TURN_SESSION)) {
      throw new Error('session did not bind')
    }
    if (!bindForgeRunDispatchTurn(ctx, observed.runId, clientMessageId)) {
      throw new Error('dispatch turn did not bind')
    }
    ledger.close()
    ledger = harness.open()
    return observed.runId
  }

  it('builds the chat host before reading a waiting run’s proof', async () => {
    const runId = interruptedRun('message-1')
    const host = protectedTurnHarness()
    host.items = protectedTurnJournal('message-1', 'done', 'completed', 'success', 'assistant')
    const events: string[] = []
    const recover = forgeInboxProjectEventRunRecoveryForRuntime({
      ensureHost: async () => {
        events.push('ensure')
        hostRef.current = {
          history: async () => {
            events.push('history')
            return host.port.history()
          }
        }
      }
    })

    await recover(ledger)

    expect(events).toEqual(['ensure', 'history'])
    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'succeeded',
      error: null
    })
  })

  it('does not build the host when no run is waiting', async () => {
    const events: string[] = []
    const recover = forgeInboxProjectEventRunRecoveryForRuntime({
      ensureHost: async () => {
        events.push('ensure')
      }
    })

    await recover(ledger)

    expect(events).toEqual([])
  })

  it('leaves the interruption verdict when the host cannot be built', async () => {
    const runId = interruptedRun('message-2')
    const recover = forgeInboxProjectEventRunRecoveryForRuntime({
      ensureHost: async () => {
        throw new Error('journal unavailable')
      }
    })

    await expect(recover(ledger)).resolves.toBeUndefined()
    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
  })

  it('does not hold owner startup open on a host install that never settles', async () => {
    vi.useFakeTimers()
    interruptedRun('message-3')
    const recover = forgeInboxProjectEventRunRecoveryForRuntime({
      ensureHost: () => new Promise<void>(() => undefined)
    })

    const result = recover(ledger)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toBeUndefined()
  })
})
