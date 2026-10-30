import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostTestRecoveryCapsuleSettled } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  createForgeProjectEventAgentLaunch,
  type ProjectEventAgentLaunch
} from './forge-inbox-project-event-agent-launch'
import { emptyProbe, launchPorts } from './forge-inbox-project-event-agent-launch-test-kit'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  HOST_TEST_SESSION,
  installRegistryHost,
  openRealCancelHost
} from './forge-inbox-project-event-run-cancel-host-kit'
import { projectEventRunCancelRuntimeFor } from './forge-inbox-project-event-run-cancel-runtime'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import {
  CANCEL_MESSAGE,
  CANCEL_REPO_ID,
  createFakeCancelHost,
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { rowNumber } from './forge-inbox-rows'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import { bindForgeRunSession } from './forge-inbox-runs'

const decidedDispatch = (): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action: 'dispatch_agent',
  confidence: 0.9,
  probabilities: {
    record_only: 0.02,
    notify: 0.02,
    wait: 0.02,
    fetch_context: 0.02,
    dispatch_agent: 0.9,
    ask_user: 0.02
  },
  usage: { inputTokens: 12, outputTokens: 3 }
})

function observeHead(opened: ForgeInboxLedger) {
  return async (): Promise<ProjectEventHeadObservation> => {
    const ctx = opened.ledgerContext()
    const head = ctx.db.prepare('SELECT id, current_revision FROM items ORDER BY id LIMIT 1').get()
    if (!head) {
      throw new Error('expected the admitted item')
    }
    const itemId = rowNumber(head, 'id')
    const revision = rowNumber(head, 'current_revision') + 1
    ctx.db
      .prepare(
        "INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at) VALUES (?, ?, 'sha256:observed', ?, ?)"
      )
      .run(itemId, revision, revision, ctx.now())
    ctx.db
      .prepare('UPDATE items SET current_revision = ?, updated_at = ? WHERE id = ?')
      .run(revision, ctx.now(), itemId)
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

describe('the launcher follows the structured host registry for a revoked dispatch stop', () => {
  let fx: DispatchLedgerFixture
  let uninstall: () => void
  let launcher: ProjectEventAgentLaunch | null

  beforeEach(() => {
    fx = openDispatchLedger()
    uninstall = () => undefined
    launcher = null
  })
  afterEach(async () => {
    await launcher?.stop?.()
    launcher?.dispose?.()
    uninstall()
    await hostTestRecoveryCapsuleSettled()
    fx.dispose()
  })

  function launchWithRegistryRuntime(): ProjectEventAgentLaunch {
    launcher = createForgeProjectEventAgentLaunch(fx.ledger, {
      ...launchPorts(emptyProbe()),
      cancel: projectEventRunCancelRuntimeFor({
        ensureStructuredAgentSessionHost: async () => undefined
      }),
      cancelRetryDelayMs: 1
    })
    return launcher
  }

  async function journaledHost() {
    const journal = createFakeCancelHost()
    journal.startTurn({ messageId: CANCEL_MESSAGE, turnId: 'turn-1' })
    return openRealCancelHost(journal)
  }

  it('stops this run exact turn on the host the registry installs after the request', async () => {
    const real = await journaledHost()
    launchWithRegistryRuntime()
    const runId = seedRun(fx.ledger, { iid: 7, sessionId: HOST_TEST_SESSION })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(real.cancels).not.toHaveBeenCalled()

    uninstall = installRegistryHost(real.host)

    await vi.waitFor(() => expect(runRow(fx.ledger, runId).cancel_delivery).not.toBeNull())
    expect(real.cancels).toHaveBeenCalledTimes(1)
    expect(real.cancels.mock.calls[0]?.[0]).toEqual({ callerKey: `forge-dispatch:${runId}` })
    expect(runRow(fx.ledger, runId).state).toBe('running')
  })

  it('releases the registry listener when stopped', async () => {
    const real = await journaledHost()
    const stopped = launchWithRegistryRuntime()
    seedRun(fx.ledger, { iid: 7, sessionId: HOST_TEST_SESSION })
    await stopped.stop?.()

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })
    uninstall = installRegistryHost(real.host)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(real.cancels).not.toHaveBeenCalled()
  })
})

describe('the owner closes its launcher before it closes the ledger', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('fences every launch a dispatch built at once, then disposes them before closing the ledger', async () => {
    fx = createOwnerFixture()
    // The owner must open a ledger that already exists; the seeded owner also committed the launch.
    const port = await freePort()
    await seedLedger(fx, listenerOn(port))
    const order: string[] = []
    let finishJobs: () => void = () => undefined
    const jobs = new Promise<void>((resolve) => {
      finishJobs = resolve
    })
    const built: ForgeInboxLedger[] = []
    const runs: number[] = []
    const service = fx.service({
      decideProjectEvent: async () => decidedDispatch(),
      observeProjectEventContext: observeHead,
      launchProjectEventAgent: (ledger) =>
        Object.assign<ProjectEventAgentLaunch, { stop: () => Promise<void>; dispose: () => void }>(
          async (input) => {
            built.push(ledger)
            bindForgeRunSession(ledger.ledgerContext(), input.runId, HOST_TEST_SESSION)
            runs.push(input.runId)
            return {
              ok: true as const,
              mode: 'structured' as const,
              sessionId: HOST_TEST_SESSION,
              promptOutcome: 'journaled' as const
            }
          },
          {
            stop: async () => {
              order.push(`stop:${ledger.isClosed()}`)
              await jobs
              order.push('jobs-ended')
            },
            dispose: () => order.push(`dispose:${ledger.isClosed()}`)
          }
        )
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    const reply = await postHook(port, mergeRequestHookBody(), 'fence-1')
    expect(reply.status).toBe(202)
    // A settled decision leaves no turn to read, so the dispatch hands the session back itself.
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    // The launch the dispatch built keeps running until close: stopping it at construction would end
    // the dispatch it was built for.
    expect(order).toEqual([])
    const [runId = -1] = runs
    await vi.waitFor(() =>
      expect(fx.rows('SELECT id, state FROM runs WHERE id = ?', runId)).toEqual([
        { id: runId, state: 'running' }
      ])
    )

    // Closing fences the launch that dispatch built, before its stop outlasts the ledger.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const stopping = service.stop()
    // Teardown begins in the stop's own microtask; the launch's fence is already recorded.
    await Promise.resolve()
    expect(order).toEqual(['stop:false'])
    const [ledger = null, ...later] = built
    expect(later).toEqual([])
    expect(ledger?.isClosed()).toBe(false)

    finishJobs()
    await stopping

    expect(order).toEqual(['stop:false', 'jobs-ended', 'dispose:false'])
    expect(ledger?.isClosed()).toBe(true)
  })
})
