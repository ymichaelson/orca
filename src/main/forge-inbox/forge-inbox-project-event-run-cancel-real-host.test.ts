import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostTestRecoveryCapsuleSettled } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  createForgeProjectEventRunCancel,
  type ProjectEventRunCancel
} from './forge-inbox-project-event-run-cancel'
import {
  HOST_TEST_SESSION,
  openRealCancelHost
} from './forge-inbox-project-event-run-cancel-host-kit'
import {
  CANCEL_MESSAGE,
  CANCEL_REPO_ID,
  createFakeCancelHost,
  createFakeCancelRuntime,
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'

describe('the stop request against the real structured host', () => {
  let fx: DispatchLedgerFixture
  let worker: ProjectEventRunCancel | null
  let journal: ReturnType<typeof createFakeCancelHost>

  beforeEach(() => {
    fx = openDispatchLedger()
    worker = null
    journal = createFakeCancelHost()
    journal.startTurn({ messageId: CANCEL_MESSAGE, turnId: 'turn-1' })
  })
  afterEach(async () => {
    await worker?.stop()
    await hostTestRecoveryCapsuleSettled()
    fx.dispose()
  })

  async function startWorker() {
    const real = await openRealCancelHost(journal)
    const runtime = createFakeCancelRuntime(real.host).runtime
    worker = createForgeProjectEventRunCancel({ ledger: fx.ledger, runtime, retryDelayMs: 1 })
    return real
  }

  it('is admitted by the real host at the lease fence with the real payload fingerprint', async () => {
    const runId = seedRun(fx.ledger, { iid: 7, sessionId: HOST_TEST_SESSION })
    const real = await startWorker()

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).not.toBeNull())
    expect(real.cancels).toHaveBeenCalledTimes(1)
    const [caller, params] = real.cancels.mock.calls[0] ?? []
    expect(caller).toEqual({ callerKey: `forge-dispatch:${runId}` })
    expect(params).toMatchObject({
      turnId: 'turn-1',
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: runRow(fx.ledger, runId).cancel_operation_id,
        expectedRuntimeFence: real.leaseFence()
      }
    })
    expect(await real.cancels.mock.results[0]?.value).toMatchObject({ ok: true, replayed: false })
    expect(runRow(fx.ledger, runId)).toMatchObject({
      state: 'running',
      cancel_fence: real.leaseFence()
    })
  })

  it('is answered from the host record when the same operation is repeated', async () => {
    const runId = seedRun(fx.ledger, { iid: 7, sessionId: HOST_TEST_SESSION })
    const real = await startWorker()
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).not.toBeNull())
    const [caller, params] = real.cancels.mock.calls[0] ?? []
    if (!caller || !params) {
      throw new Error('expected the first stop')
    }

    expect(await real.host.cancel(caller, params)).toMatchObject({ ok: true, replayed: true })
  })

  it('does not call a stop accepted when the real host had no live turn to interrupt', async () => {
    const runId = seedRun(fx.ledger, { iid: 7, sessionId: HOST_TEST_SESSION })
    const real = await startWorker()

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).toBe('refused'))
    // The host answered but interrupted nothing while the journal still shows the turn live.
    expect(await real.cancels.mock.results[0]?.value).toMatchObject({
      ok: true,
      value: { turnId: 'turn-1', cancelled: false }
    })
    expect(runRow(fx.ledger, runId)).toMatchObject({ state: 'running', error: null })
  })
})
