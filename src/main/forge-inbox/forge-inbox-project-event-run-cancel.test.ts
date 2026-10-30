import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createForgeProjectEventRunCancel,
  type ProjectEventRunCancel
} from './forge-inbox-project-event-run-cancel'
import { readRunCancellationViews } from './forge-inbox-project-event-run-cancel-state'
import {
  CANCEL_MESSAGE,
  CANCEL_REPO_ID,
  CANCEL_SESSION,
  OPERATION_ID_PATTERN,
  OTHER_REPO_ID,
  createFakeCancelHost,
  createFakeCancelRuntime,
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { createForgeProjectEventRunWatch } from './forge-inbox-project-event-run-watch'
import { readForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { bindForgeRunDispatchTurn, transitionForgeRun } from './forge-inbox-runs'

const TURN = { messageId: CANCEL_MESSAGE, turnId: 'turn-1' }

describe('stopping a dispatched run whose policy was revoked', () => {
  let fx: DispatchLedgerFixture
  let fake: ReturnType<typeof createFakeCancelHost>
  let rt: ReturnType<typeof createFakeCancelRuntime>
  let workers: ProjectEventRunCancel[]
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fx = openDispatchLedger()
    fake = createFakeCancelHost()
    rt = createFakeCancelRuntime(fake.host)
    workers = []
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.stop()))
    fx.dispose()
    vi.useRealTimers()
    warn.mockRestore()
  })

  function watchFor(ledger: ForgeInboxLedger) {
    return createForgeProjectEventRunWatch({
      ledger,
      readTurnProof: (sessionId, clientMessageId) =>
        readForgeProtectedTurnProof(fake.host, sessionId, clientMessageId),
      subscribeTurnCompletions: fake.subscribeTurnCompletions,
      retryDelayMs: 1
    })
  }

  function start(
    options: { ledger?: ForgeInboxLedger; maxAttempts?: number; retryDelayMs?: number } = {}
  ) {
    const ledger = options.ledger ?? fx.ledger
    const runWatch = watchFor(ledger)
    const worker = createForgeProjectEventRunCancel({
      ledger,
      runtime: rt.runtime,
      runWatch,
      retryDelayMs: options.retryDelayMs ?? 1,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      callTimeoutMs: 5_000
    })
    workers.push(worker)
    return { worker, runWatch }
  }

  /** A run the launcher dispatched: running, bound to its session and turn, and followed by the watch. */
  function dispatched(runWatch: ReturnType<typeof watchFor>, iid = 7): number {
    const runId = seedRun(fx.ledger, { iid })
    fake.startTurn(TURN)
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    return runId
  }

  const fingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.cancel',
    sessionId: CANCEL_SESSION,
    fields: { turnId: TURN.turnId }
  })

  it('asks the host to stop this run exact turn, and stays stopping until that turn proves how it ended', async () => {
    const { runWatch } = start()
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
    const row = runRow(fx.ledger, runId)
    expect(fake.calls).toEqual([
      {
        callerKey: `forge-dispatch:${runId}`,
        sessionId: CANCEL_SESSION,
        operationId: row.cancel_operation_id,
        fence: 7,
        payloadFingerprint: fingerprint,
        turnId: TURN.turnId
      }
    ])
    expect(row.cancel_operation_id).toMatch(OPERATION_ID_PATTERN)
    // The host took the request; it has not said the turn ended, so the run is still running.
    expect(row).toMatchObject({ state: 'running', error: null, cancel_fence: 7 })
    expect(readRunCancellationViews(fx.ledger.ledgerContext(), [runId]).get(runId)).toEqual({
      requestedAt: row.cancel_requested_at,
      delivery: 'accepted'
    })

    fake.completeTurn(CANCEL_MESSAGE, 'cancellation')

    await vi.waitFor(() =>
      expect(runRow(fx.ledger, runId)).toMatchObject({ state: 'cancelled', error: 'cancelled' })
    )
  })

  it('lets the turn own the verdict when it finished anyway', async () => {
    const { runWatch } = start()
    const runId = dispatched(runWatch)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))

    fake.completeTurn(CANCEL_MESSAGE, 'success')

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).state).toBe('succeeded'))
  })

  it('never stops a turn it cannot prove is its own, and never a later unrelated one', async () => {
    const { runWatch } = start({ maxAttempts: 200 })
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    fake.startTurn({ messageId: 'other-message', turnId: 'turn-9' })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.historyReads()).toBeGreaterThan(0))
    expect(fake.calls).toEqual([])

    fake.startTurn(TURN)

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    expect(fake.calls[0]).toMatchObject({ turnId: 'turn-1' })
  })

  it('sends no stop for a turn that already ended, and settles the run from that proof alone', async () => {
    start()
    const runId = seedRun(fx.ledger, { iid: 7 })
    fake.startTurn({ ...TURN, state: 'completed', outcome: 'success' })
    fake.startTurn({ messageId: 'later-message', turnId: 'turn-2' })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    // No completion event follows: the proof on record is all there is.
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).state).toBe('succeeded'))
    expect(fake.calls).toEqual([])
  })

  it('settles the run when the host ends the turn before it returns the receipt', async () => {
    fake.control.completeOnCancel = 'cancellation'
    const { runWatch } = start()
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await vi.waitFor(() =>
      expect(runRow(fx.ledger, runId)).toMatchObject({ state: 'cancelled', error: 'cancelled' })
    )
  })

  it('settles when the completion lands while the proof is being read and the stop is then followed', async () => {
    const { runWatch } = start()
    const runId = dispatched(runWatch)
    const release = fake.holdHistory()
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.historyReads()).toBeGreaterThan(0))

    fake.completeTurn(CANCEL_MESSAGE, 'cancellation')
    release()

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).state).toBe('cancelled'))
  })

  it('stops the original turn when its journal row opens only after the retry budget is spent', async () => {
    const { runWatch } = start({ maxAttempts: 2 })
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    const reads = fake.historyReads()
    fake.emitStatus('some-other-session')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.historyReads()).toBe(reads)

    fake.startTurn(TURN)
    fake.emitStatus(CANCEL_SESSION)

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    expect(fake.calls[0]).toMatchObject({ turnId: 'turn-1', callerKey: `forge-dispatch:${runId}` })
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
  })

  it('wakes a waiting stop from its own session before the backoff would', async () => {
    const { runWatch } = start({ maxAttempts: 50, retryDelayMs: 600_000 })
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(1))
    expect(fake.calls).toEqual([])

    fake.startTurn(TURN)
    fake.emitStatus(CANCEL_SESSION)

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    expect(fake.calls[0]).toMatchObject({ turnId: 'turn-1' })
  })

  describe.each([
    ['refuses it', 'refuse', 'refused'],
    ['takes it', 'accept', 'accepted']
  ] as const)(
    'a stop parked on an unproven turn that the host then %s',
    (_name, mode, delivery) => {
      it('stops waiting once its turn is proven and never asks again on later status events', async () => {
        const { runWatch } = start({ maxAttempts: 50, retryDelayMs: 600_000 })
        const runId = seedRun(fx.ledger, { iid: 7 })
        runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
        updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
        await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(1))
        fake.control.mode = mode
        fake.startTurn(TURN)
        fake.emitStatus(CANCEL_SESSION)
        await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe(delivery))
        const asked = runRow(fx.ledger, runId).cancel_operation_id

        expect(fake.statusSubscriberCount()).toBe(0)
        for (let index = 0; index < 2; index++) {
          fake.emitStatus(CANCEL_SESSION)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(fake.calls).toHaveLength(1)
        expect(runRow(fx.ledger, runId).cancel_operation_id).toBe(asked)
      })
    }
  )

  it('records nothing and subscribes to nothing when the worker stops during the post-receipt proof read', async () => {
    fake.control.mode = 'decline'
    const { worker, runWatch } = start()
    const runId = dispatched(runWatch)
    let release: () => void = () => undefined
    let readsAtCancel = 0
    fake.control.onCancel = () => {
      release = fake.holdHistory()
      readsAtCancel = fake.historyReads()
    }
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await vi.waitFor(() => expect(fake.historyReads()).toBeGreaterThan(readsAtCancel))
    const watching = vi.spyOn(runWatch, 'watch')

    const stopped = worker.stop()
    release()
    await stopped
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runRow(fx.ledger, runId).cancel_delivery).toBeNull()
    expect(fake.statusSubscriberCount()).toBe(0)
    expect(watching).not.toHaveBeenCalled()
  })

  it('discards a post-receipt proof read that a host replacement overtook', async () => {
    fake.control.mode = 'decline'
    const { runWatch } = start({ maxAttempts: 2 })
    const runId = dispatched(runWatch)
    let release: () => void = () => undefined
    let readsAtCancel = 0
    fake.control.onCancel = () => {
      release = fake.holdHistory()
      readsAtCancel = fake.historyReads()
    }
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await vi.waitFor(() => expect(fake.historyReads()).toBeGreaterThan(readsAtCancel))
    const replacement = createFakeCancelHost()
    replacement.control.holdsSession = false
    replacement.startTurn(TURN)

    rt.replace(replacement.host)
    release()

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable')
    expect(fake.statusSubscriberCount()).toBe(0)
  })

  it('stops waiting when the run settles, with no further status event', async () => {
    const { runWatch } = start({ maxAttempts: 50, retryDelayMs: 600_000 })
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(1))

    transitionForgeRun(fx.ledger.ledgerContext(), runId, { to: 'cancelled', error: 'cancelled' })

    await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(0))
  })

  it('reads the journal a bounded number of times for a burst of status events', async () => {
    const { runWatch } = start({ maxAttempts: 500, retryDelayMs: 100 })
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(1))
    const reads = fake.historyReads()

    for (let index = 0; index < 100; index++) {
      fake.emitStatus(CANCEL_SESSION)
      await Promise.resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fake.historyReads() - reads).toBeLessThanOrEqual(3)
  })

  it('holds no status subscription when a proven turn could not be stopped', async () => {
    fake.control.mode = 'throw'
    const { runWatch } = start({ maxAttempts: 2 })
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    expect(fake.statusSubscriberCount()).toBe(0)
  })

  it('does not call a stop accepted when the host declined to stop a live turn', async () => {
    fake.control.mode = 'decline'
    const { runWatch } = start()
    const runId = dispatched(runWatch)
    fake.startTurn({ messageId: 'other-message', turnId: 'turn-9' })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('refused'))
    for (let index = 0; index < 3; index++) {
      fake.emitStatus(CANCEL_SESSION)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ turnId: 'turn-1' })
    expect(runRow(fx.ledger, runId).state).toBe('running')

    fake.completeTurn(CANCEL_MESSAGE, 'cancellation')

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).state).toBe('cancelled'))
  })

  it('accepts a decline that only reports a turn already over', async () => {
    fake.control.mode = 'decline'
    fake.control.completeOnCancel = 'success'
    const { runWatch } = start()
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).state).toBe('succeeded'))
    expect(fake.calls).toHaveLength(1)
  })

  it('listens to the status feed only while a stop waits on a turn', async () => {
    const { worker, runWatch } = start({ maxAttempts: 2 })
    expect(fake.statusSubscriberCount()).toBe(0)
    const runId = seedRun(fx.ledger, { iid: 7 })
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.statusSubscriberCount()).toBe(1))

    await worker.stop()

    expect(fake.statusSubscriberCount()).toBe(0)
  })

  it('waits for the turn to be bound before it names one', async () => {
    const { runWatch } = start()
    const runId = seedRun(fx.ledger, { iid: 7, messageId: null })
    fake.startTurn(TURN)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls).toEqual([])
    expect(fake.historyReads()).toBe(0)

    bindForgeRunDispatchTurn(fx.ledger.ledgerContext(), runId, CANCEL_MESSAGE)
    runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
  })

  it('stops only the runs of the repository whose policy changed', async () => {
    const { runWatch } = start()
    const mine = dispatched(runWatch)
    const other = seedRun(fx.ledger, { iid: 8, gitlabPath: 'group/other' })
    runWatch.watch(CANCEL_SESSION, other, CANCEL_MESSAGE)
    const analysis = seedRun(fx.ledger, { iid: 9, reason: 'review_request' })

    updatePolicy(fx.ledger, OTHER_REPO_ID, { enabled: false })

    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls.map((call) => call.callerKey)).toEqual([`forge-dispatch:${other}`])
    expect(runRow(fx.ledger, mine).cancel_requested_at).toBeNull()
    expect(runRow(fx.ledger, analysis).cancel_requested_at).toBeNull()
  })

  it('replays a stop that was committed before a restart without launching or sending anything', async () => {
    const first = dispatched(watchFor(fx.ledger))
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    const asked = runRow(fx.ledger, first)
    const restarted = createFakeCancelHost()
    restarted.startTurn(TURN)
    fake = restarted
    rt.replace(restarted.host)
    const reopened = fx.reopen()
    expect(runRow(reopened, first)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome',
      cancel_operation_id: asked.cancel_operation_id
    })

    start({ ledger: reopened })

    await vi.waitFor(() => expect(restarted.calls).toHaveLength(1))
    expect(restarted.calls[0]).toMatchObject({
      operationId: asked.cancel_operation_id,
      turnId: 'turn-1'
    })
    // The interrupted verdict stands until the turn proves how it ended.
    expect(runRow(reopened, first).state).toBe('unverifiable')

    restarted.completeTurn(CANCEL_MESSAGE, 'cancellation')

    await vi.waitFor(() =>
      expect(runRow(reopened, first)).toMatchObject({ state: 'cancelled', error: 'cancelled' })
    )
  })

  it('shows a refused stop honestly and asks again only when the runtime changes', async () => {
    fake.control.mode = 'refuse'
    const { runWatch } = start()
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('refused'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls).toHaveLength(1)
    expect(runRow(fx.ledger, runId).state).toBe('running')
    const refusedOperation = runRow(fx.ledger, runId).cancel_operation_id

    const replacement = createFakeCancelHost({ fence: 12 })
    replacement.startTurn(TURN)
    rt.replace(replacement.host)

    await vi.waitFor(() => expect(replacement.calls).toHaveLength(1))
    expect(replacement.calls[0]?.fence).toBe(12)
    expect(replacement.calls[0]?.operationId).not.toBe(refusedOperation)
    await vi.waitFor(() =>
      expect(runRow(fx.ledger, runId)).toMatchObject({
        cancel_delivery: 'accepted',
        cancel_fence: 12,
        state: 'running'
      })
    )
  })

  it('retries an unreachable host with the same operation, then says it could not be reached', async () => {
    fake.control.mode = 'throw'
    const { runWatch } = start({ maxAttempts: 3 })
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    expect(fake.calls).toHaveLength(3)
    expect(new Set(fake.calls.map((call) => call.operationId)).size).toBe(1)
    expect(runRow(fx.ledger, runId).state).toBe('running')
    expect(readRunCancellationViews(fx.ledger.ledgerContext(), [runId]).get(runId)?.delivery).toBe(
      'unreachable'
    )
  })

  it('recovers when the host answers on a later attempt', async () => {
    fake.control.mode = 'throw'
    const { runWatch } = start({ maxAttempts: 200 })
    const runId = dispatched(runWatch)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0))

    fake.control.mode = 'accept'

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('accepted'))
  })

  it('discards a late answer from a replaced host and asks the new one with its own fence', async () => {
    fake.control.mode = 'hang'
    const { runWatch } = start()
    const runId = dispatched(runWatch)
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    const operationId = runRow(fx.ledger, runId).cancel_operation_id

    const replacement = createFakeCancelHost({ fence: 21 })
    replacement.startTurn(TURN)
    rt.replace(replacement.host)
    await vi.waitFor(() => expect(replacement.calls).toHaveLength(1))
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_fence).toBe(21))
    expect(replacement.calls[0]).toMatchObject({ fence: 21, operationId })

    fake.releaseHungCancels()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runRow(fx.ledger, runId)).toMatchObject({
      cancel_delivery: 'accepted',
      cancel_fence: 21,
      state: 'running'
    })
  })

  it('does not stop anything on a host that does not hold the session', async () => {
    const { runWatch } = start({ maxAttempts: 2 })
    const runId = dispatched(runWatch)
    const replacement = createFakeCancelHost()
    replacement.control.holdsSession = false
    replacement.startTurn(TURN)
    rt.replace(replacement.host)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    expect(replacement.calls).toEqual([])
    expect(runRow(fx.ledger, runId).state).toBe('running')
  })

  it('says a stop was not delivered when no host is available', async () => {
    rt.replace(null)
    const { runWatch } = start({ maxAttempts: 2 })
    const runId = dispatched(runWatch)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('unreachable'))
    expect(runRow(fx.ledger, runId).state).toBe('running')
  })

  describe('shutting down', () => {
    it('ends at once on a stop that never answers, and ignores the answer when it arrives', async () => {
      fake.control.mode = 'hang'
      const { worker, runWatch } = start()
      const runId = dispatched(runWatch)
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1))

      await worker.stop()
      fake.releaseHungCancels()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(runRow(fx.ledger, runId).cancel_delivery).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })

    it('writes nothing once the ledger closes behind a stopped worker', async () => {
      const release = fake.holdHistory()
      const { worker, runWatch } = start()
      const runId = dispatched(runWatch)
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await vi.waitFor(() => expect(fake.historyReads()).toBeGreaterThan(0))

      await worker.stop()
      const reopened = fx.reopen()
      release()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(fake.calls).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      expect(runRow(reopened, runId).cancel_delivery).toBeNull()
    })

    it('leaves no timer, listener or later effect behind', async () => {
      vi.useFakeTimers()
      const { worker, runWatch } = start({ retryDelayMs: 60_000 })
      const runId = seedRun(fx.ledger, { iid: 7 })
      runWatch.watch(CANCEL_SESSION, runId, CANCEL_MESSAGE)
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
      await vi.advanceTimersByTimeAsync(10)
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      await worker.stop()
      runWatch.dispose()

      expect(vi.getTimerCount()).toBe(0)
      expect(rt.listenerCount()).toBe(0)
      fake.startTurn(TURN)
      updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'Newer rules.' })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fake.calls).toEqual([])
    })

    it('can be stopped twice', async () => {
      const { worker } = start()
      await worker.stop()
      await worker.stop()
    })
  })
})
