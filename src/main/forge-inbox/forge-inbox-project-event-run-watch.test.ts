import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { createForgeProjectEventRunWatch } from './forge-inbox-project-event-run-watch'
import {
  bindForgeRunSession,
  markForgeRunUnverifiableIfRunning,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }
const SESSION = 'structured-claude-1'
const SEND = 'send-1'
const flush = async () => {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

describe('project event run watch', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
  })
  afterEach(() => {
    vi.useRealTimers()
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
    return observed.runId
  }

  function harnessFeed() {
    const emitted: ((event: AgentSessionTurnCompletionEvent) => void)[] = []
    let unsubscribed = 0
    // The original turn's journal verdict by send id; an absent entry is unprovable.
    const proofs = new Map<string, AgentJournalTurnOutcome>()
    let reader: ((id: string) => Promise<ForgeProtectedTurnProof | null>) | null = null
    const watch = createForgeProjectEventRunWatch({
      ledger,
      retryDelayMs: 5,
      readTurnProof: async (_session, clientMessageId): Promise<ForgeProtectedTurnProof | null> => {
        if (reader) {
          return reader(clientMessageId)
        }
        const outcome = proofs.get(clientMessageId)
        return outcome ? { turnId: 't', terminal: true, outcome, text: null } : null
      },
      subscribeTurnCompletions: (subscriber) => {
        emitted.push(subscriber.emit)
        return () => {
          unsubscribed += 1
        }
      }
    })
    return {
      watch,
      readWith: (next: typeof reader) => {
        reader = next
      },
      prove: (outcome: AgentJournalTurnOutcome, id = SEND) => proofs.set(id, outcome),
      complete: async (sessionId: string, outcome: AgentJournalTurnOutcome) => {
        emitted.forEach((emit) =>
          emit({
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
              outcome,
              completedAt: 1
            }
          })
        )
        await flush()
        await flush()
        await flush()
      },
      end: () => emitted.forEach((emit) => emit({ type: 'end' })),
      subscriptions: () => emitted.length,
      unsubscribed: () => unsubscribed
    }
  }

  it('settles from a terminal proof already on record when asked to prove at registration', async () => {
    const feed = harnessFeed()
    const runId = runningRun()
    feed.prove('cancellation')

    feed.watch.watch(SESSION, runId, SEND, { proveNow: true })
    await flush()

    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'cancelled',
      error: 'cancelled'
    })
  })

  it('settles from a proof read that was in flight when the same send is watched again', async () => {
    const feed = harnessFeed()
    const runId = runningRun()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    feed.readWith(async () => {
      await gate
      return { turnId: 't', terminal: true, outcome: 'cancellation', text: null }
    })
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'cancellation')

    feed.watch.watch(SESSION, runId, SEND, { proveNow: true })
    release()
    await flush()

    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({ state: 'cancelled' })
  })

  it('does not borrow an unrelated refused send outcome', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'failure')
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('running')
  })

  it('never adopts a later turn verdict once the original is proven', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'failure')
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('succeeded')
  })

  it('settles a successful turn as a succeeded run with the session kept', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, runId, SEND)

    await feed.complete(SESSION, 'success')

    const run = readForgeRun(ledger.ledgerContext(), runId)
    expect(run).toMatchObject({ state: 'succeeded', error: null, sessionId: SESSION })
  })

  it('maps the provider failure, cancellation and supersede to honest states', async () => {
    const failed = runningRun(SESSION)
    const cancelled = runningRun('structured-claude-2')
    const superseded = runningRun('structured-claude-3')
    const feed = harnessFeed()
    feed.watch.watch(SESSION, failed, 'a')
    feed.watch.watch('structured-claude-2', cancelled, 'b')
    feed.watch.watch('structured-claude-3', superseded, 'c')

    feed.prove('failure', 'a')
    feed.prove('cancellation', 'b')
    feed.prove('superseded', 'c')
    await feed.complete(SESSION, 'failure')
    await feed.complete('structured-claude-2', 'cancellation')
    await feed.complete('structured-claude-3', 'superseded')

    expect(readForgeRun(ledger.ledgerContext(), failed)).toMatchObject({
      state: 'failed',
      error: 'agent-failure'
    })
    expect(readForgeRun(ledger.ledgerContext(), cancelled)).toMatchObject({
      state: 'cancelled',
      error: 'cancelled'
    })
    expect(readForgeRun(ledger.ledgerContext(), superseded)).toMatchObject({
      state: 'cancelled',
      error: 'superseded'
    })
  })

  it('ignores a completion of a session it does not track', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.watch.watch(SESSION, runId, SEND)

    await feed.complete('someone-else', 'success')

    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('running')
  })

  it('does not settle a run that was cancelled in the meantime', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.watch.watch(SESSION, runId, SEND)
    transitionForgeRun(ledger.ledgerContext(), runId, { to: 'cancelled', error: 'revoked' })
    const generation = readForgeRun(ledger.ledgerContext(), runId)?.generation

    feed.prove('success')
    await feed.complete(SESSION, 'success')
    await feed.complete(SESSION, 'failure')

    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'cancelled',
      error: 'revoked',
      generation
    })
  })

  it('subscribes once, and on the end of the feed hands running runs to the next start', async () => {
    const first = runningRun()
    const second = runningRun('structured-claude-2')
    const feed = harnessFeed()
    expect(feed.subscriptions()).toBe(0)

    feed.watch.watch(SESSION, first, SEND)
    feed.watch.watch('structured-claude-2', second, 'b')
    expect(feed.subscriptions()).toBe(1)

    feed.end()
    expect(feed.unsubscribed()).toBe(1)
    await feed.complete(SESSION, 'success')

    expect(readForgeRun(ledger.ledgerContext(), first)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
    expect(readForgeRun(ledger.ledgerContext(), second)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
  })

  it('leaves an already settled run alone when the feed ends', async () => {
    const settled = runningRun()
    const live = runningRun('structured-claude-2')
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, settled, SEND)
    feed.watch.watch('structured-claude-2', live, 'b')
    await feed.complete(SESSION, 'success')

    feed.end()

    expect(readForgeRun(ledger.ledgerContext(), settled)).toMatchObject({
      state: 'succeeded',
      error: null
    })
    expect(readForgeRun(ledger.ledgerContext(), live)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
  })

  it('keeps its subscription when a write fails transiently', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, runId, SEND)
    const db = ledger.ledgerContext().db
    db.exec(
      `CREATE TRIGGER fail_runs_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'busy'); END`
    )

    await feed.complete(SESSION, 'success')

    expect(feed.unsubscribed()).toBe(0)
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('running')

    db.exec('DROP TRIGGER fail_runs_update')
    await feed.complete(SESSION, 'success')

    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('succeeded')
  })

  it('stops once the ledger it writes to is closed', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.watch.watch(SESSION, runId, SEND)
    ledger.close()

    await feed.complete(SESSION, 'success')

    expect(feed.unsubscribed()).toBe(1)
  })

  const terminal = (outcome: AgentJournalTurnOutcome): ForgeProtectedTurnProof => ({
    turnId: 't',
    terminal: true,
    outcome,
    text: null
  })
  const running = (): ForgeProtectedTurnProof => ({
    turnId: 't',
    terminal: false,
    outcome: null,
    text: null
  })
  const settleSoon = () => vi.advanceTimersByTimeAsync(100)

  it('settles when the original turn is non-terminal at first and terminal at a later event', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    let reads = 0
    feed.readWith(async () => (++reads === 1 ? running() : terminal('success')))
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'success')
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('running')
    await feed.complete(SESSION, 'success')
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('succeeded')
  })

  it('reads again when an event arrives during a read', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    let release: (proof: ForgeProtectedTurnProof | null) => void = () => {}
    let reads = 0
    feed.readWith(() =>
      ++reads === 1
        ? new Promise((resolve) => {
            release = resolve
          })
        : Promise.resolve(terminal('success'))
    )
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'success')
    await feed.complete(SESSION, 'success')
    release(running())
    await flush()
    await flush()
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('succeeded')
  })

  it('retries an unprovable read without another event, then stops after a bound', async () => {
    vi.useFakeTimers()
    const runId = runningRun()
    const feed = harnessFeed()
    let reads = 0
    feed.readWith(async () => (++reads < 3 ? null : terminal('failure')))
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'failure')
    await settleSoon()
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('failed')

    const stuck = runningRun('structured-claude-9')
    let stuckReads = 0
    feed.readWith(async () => {
      stuckReads++
      return null
    })
    feed.watch.watch('structured-claude-9', stuck, 'send-9')
    await feed.complete('structured-claude-9', 'failure')
    await settleSoon()
    await settleSoon()
    const after = stuckReads
    await settleSoon()
    expect(stuckReads).toBe(after)
    expect(after).toBeLessThanOrEqual(8)
    expect(readForgeRun(ledger.ledgerContext(), stuck)?.state).toBe('running')
  })

  it('settles a run the launcher already marked unknown-outcome', async () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, runId, SEND)
    transitionForgeRun(ledger.ledgerContext(), runId, {
      to: 'unverifiable',
      error: 'unknown-outcome'
    })
    await feed.complete(SESSION, 'success')
    expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
      state: 'succeeded',
      error: null
    })
  })

  it('retries a transient write failure on its own timer', async () => {
    vi.useFakeTimers()
    const runId = runningRun()
    const feed = harnessFeed()
    feed.prove('success')
    feed.watch.watch(SESSION, runId, SEND)
    const db = ledger.ledgerContext().db
    db.exec(
      `CREATE TRIGGER fail_runs_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'busy'); END`
    )
    await feed.complete(SESSION, 'success')
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('running')
    db.exec('DROP TRIGGER fail_runs_update')
    await settleSoon()
    expect(readForgeRun(ledger.ledgerContext(), runId)?.state).toBe('succeeded')
  })

  it('drops a pending retry when the same run is watched again', async () => {
    vi.useFakeTimers()
    const runId = runningRun()
    const feed = harnessFeed()
    const asked: string[] = []
    feed.readWith(async (id) => {
      asked.push(id)
      return null
    })
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'failure')
    expect(asked).toEqual([SEND])

    expect(vi.getTimerCount()).toBe(1)
    feed.watch.watch(SESSION, runId, 'send-2')
    expect(vi.getTimerCount()).toBe(0)
    await settleSoon()

    expect(asked).toEqual([SEND])
  })

  it('re-arms retries when a new completion event arrives after they ran out', async () => {
    vi.useFakeTimers()
    const runId = runningRun()
    const feed = harnessFeed()
    let reads = 0
    feed.readWith(async () => {
      reads++
      return null
    })
    feed.watch.watch(SESSION, runId, SEND)
    await feed.complete(SESSION, 'failure')
    await settleSoon()
    const exhausted = reads

    await feed.complete(SESSION, 'failure')
    await settleSoon()

    expect(reads).toBeGreaterThanOrEqual(exhausted + 3)
  })

  describe('readable result', () => {
    const REPORT = '```orca-effect-report\n{"v":1,"mode":"read-only","claims":[]}\n```'

    function proofWith(text: string | null, outcome: AgentJournalTurnOutcome = 'success') {
      return async (): Promise<ForgeProtectedTurnProof> => ({
        turnId: 't',
        terminal: true,
        outcome,
        text
      })
    }

    it('keeps the human text of the proven turn as the run result, without the report fence', async () => {
      const runId = runningRun()
      const feed = harnessFeed()
      feed.readWith(proofWith(`Approved after review.\n\n${REPORT}\n`))
      feed.watch.watch(SESSION, runId, SEND)

      await feed.complete(SESSION, 'success')

      expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
        state: 'succeeded',
        result: { summary: 'Approved after review.', concerns: [] }
      })
    })

    it('keeps useful text of a failed turn while the verdict stays failed', async () => {
      const runId = runningRun()
      const feed = harnessFeed()
      feed.readWith(proofWith('Could not finish: tests broke.', 'failure'))
      feed.watch.watch(SESSION, runId, SEND)

      await feed.complete(SESSION, 'failure')

      expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
        state: 'failed',
        error: 'agent-failure',
        result: { summary: 'Could not finish: tests broke.' }
      })
    })

    it('leaves the result unavailable when the turn has no readable text', async () => {
      const runId = runningRun()
      const feed = harnessFeed()
      feed.readWith(proofWith(null))
      feed.watch.watch(SESSION, runId, SEND)

      await feed.complete(SESSION, 'success')

      expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
        state: 'succeeded',
        result: null
      })
    })

    it('records the result when it replaces an interruption verdict', async () => {
      const runId = runningRun()
      const feed = harnessFeed()
      feed.watch.watch(SESSION, runId, SEND)
      expect(markForgeRunUnverifiableIfRunning(ledger.ledgerContext(), runId)).toBe(true)
      feed.readWith(proofWith('Merged cleanly.'))

      await feed.complete(SESSION, 'success')

      expect(readForgeRun(ledger.ledgerContext(), runId)).toMatchObject({
        state: 'succeeded',
        result: { summary: 'Merged cleanly.' }
      })
    })
  })

  it('leaves the closed ledger alone when disposed', () => {
    const runId = runningRun()
    const feed = harnessFeed()
    feed.watch.watch(SESSION, runId, SEND)
    ledger.close()

    expect(() => feed.watch.dispose()).not.toThrow()
    expect(feed.unsubscribed()).toBe(1)
  })
})
