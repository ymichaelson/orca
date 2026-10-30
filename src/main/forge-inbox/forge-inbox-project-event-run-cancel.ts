import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  listOpenRunCancelRequests,
  recordRunCancelDelivery,
  renewRunCancelOperation,
  type RunCancelRequest,
  type StoredRunCancelDelivery
} from './forge-inbox-project-event-run-cancel-state'
import { boundedCall, type Bounded } from './forge-inbox-bounded-call'
import { ownTurnEnded, requestTurnStop } from './forge-inbox-project-event-run-cancel-request'
import { createStopWaiter } from './forge-inbox-project-event-run-cancel-waiter'
import type { ProjectEventRunWatch } from './forge-inbox-project-event-run-watch'
import type { ForgeProtectedSessionTurnHost } from './forge-inbox-protected-session-turn'
import { readForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'

/** Only what a stop reads and writes on a host: its journal, its session leases and its Stop. */
export type ProjectEventRunCancelHost = Pick<
  ForgeProtectedSessionTurnHost,
  'history' | 'sessionRecord'
> &
  Pick<StructuredAgentSessionHost, 'cancel' | 'subscribeStatus'>

export type ProjectEventRunCancelRuntime = {
  /** The current structured host, built on demand; null when none can be had. */
  host(): Promise<ProjectEventRunCancelHost | null>
  /** Fires when another host is installed, so a stop the old one never settled is asked of the new. */
  onHostChanged(listener: () => void): () => void
}

export type ProjectEventRunCancel = {
  wake(options?: { replay?: boolean }): void
  /** Fences every later effect at once; resolves when the jobs it already started have ended. */
  stop(): Promise<void>
}

export type ProjectEventRunCancelDeps = {
  ledger: ForgeInboxLedger
  runtime: ProjectEventRunCancelRuntime
  /** Keeps following the stopped run's turn, so only that turn's own proof settles it. */
  runWatch?: ProjectEventRunWatch
  retryDelayMs?: number
  maxAttempts?: number
  callTimeoutMs?: number
}

const DEFAULT_RETRY_DELAY_MS = 500
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_CALL_TIMEOUT_MS = 10_000

type Job = {
  controller: AbortController
  attempts: number
  /** The host this job last reached, whose status feed announces the turn it waits on. */
  host: ProjectEventRunCancelHost | null
  /** The last attempt found no proof of the turn, so only a status event can say it has appeared. */
  unproven: boolean
  /** Cuts the current backoff short when the awaited session changes. */
  nudge: (() => void) | null
}
type Step = 'done' | 'retry'

/**
 * Delivers the stop a policy change committed: for each requested run it proves the run's own
 * dispatched turn, then asks the host to stop exactly that turn at the session's current fence.
 * The host's answer is a receipt, never a verdict; the run stays running until its watch sees the
 * turn's own proof.
 */
export function createForgeProjectEventRunCancel(
  deps: ProjectEventRunCancelDeps
): ProjectEventRunCancel {
  const { ledger, runtime } = deps
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const jobs = new Map<number, Job>()
  const running = new Set<Promise<void>>()
  /** Runs whose request needs nothing more from this runtime, keyed to the request they were judged for. */
  const settled = new Map<number, string>()
  let stopped = false

  const live = (): boolean => !stopped && !ledger.isClosed()

  const guarded = <T>(job: Job, work: Promise<T>, timeoutMs: number): Promise<Bounded<T>> =>
    boundedCall(job.controller.signal, work, timeoutMs)

  function pause(job: Job, ms: number): Promise<void> {
    const woken = new Promise<void>((resolve) => {
      job.nudge = resolve
    })
    return guarded(job, woken, ms).then(() => {
      job.nudge = null
    })
  }

  /** Proves at registration too: the turn may have ended with no completion event left to come. */
  function follow(request: RunCancelRequest): void {
    deps.runWatch?.watch(request.sessionId, request.runId, request.clientMessageId, {
      proveNow: true
    })
  }

  const eligible = (request: RunCancelRequest): boolean =>
    !jobs.has(request.runId) && settled.get(request.runId) !== request.operationId

  const waiter = createStopWaiter(
    (entry) => {
      if (!live()) {
        return
      }
      const job = jobs.get(entry.runId)
      if (job) {
        job.nudge?.()
        return
      }
      const open = listOpenRunCancelRequests(ledger.ledgerContext(), { replay: true }).find(
        (request) => request.runId === entry.runId
      )
      if (!open) {
        waiter.release(entry.runId)
      } else {
        start(open)
      }
    },
    retryDelayMs,
    () => Date.now()
  )

  function record(
    request: Pick<RunCancelRequest, 'runId' | 'itemId' | 'operationId'>,
    delivery: StoredRunCancelDelivery,
    fence: number | null
  ): void {
    try {
      recordRunCancelDelivery(ledger.ledgerContext(), request, delivery, fence)
    } catch (error) {
      if (live()) {
        console.warn('[forge-inbox] recording a stop request failed', forgeErrorLabel(error))
      }
    }
  }

  async function attempt(request: RunCancelRequest, job: Job): Promise<Step> {
    const here = (): boolean => live() && jobs.get(request.runId) === job
    const hosted = await guarded(job, runtime.host(), callTimeoutMs)
    if (!here()) {
      return 'done'
    }
    const host = hosted.ok ? hosted.value : null
    if (!host) {
      return 'retry'
    }
    job.host = host
    const proved = await guarded(
      job,
      readForgeProtectedTurnProof(host, request.sessionId, request.clientMessageId),
      callTimeoutMs
    )
    if (!here()) {
      return 'done'
    }
    const proof = proved.ok ? proved.value : null
    if (proof === null) {
      // Not provable yet is not stoppable yet: a stop never names a turn it cannot attribute.
      job.unproven = true
      waiter.park({ runId: request.runId, sessionId: request.sessionId }, host)
      return 'retry'
    }
    // The turn is shown: nothing is left to wait for, whatever the host answers next.
    job.unproven = false
    waiter.release(request.runId)
    if (proof.terminal) {
      settled.set(request.runId, request.operationId)
      follow(request)
      return 'done'
    }
    const fence = host.sessionRecord(request.sessionId)?.lease.runtimeFence
    if (fence === undefined) {
      return 'retry'
    }
    let operationId = request.operationId
    if (request.delivery !== null) {
      if (request.delivery === 'accepted' && request.fence === fence) {
        settled.set(request.runId, request.operationId)
        follow(request)
        return 'done'
      }
      // The host would answer a repeated id from its record, so a new runtime or attempt gets a new one.
      const renewed = renewRunCancelOperation(ledger.ledgerContext(), request)
      if (renewed === null) {
        return 'done'
      }
      // Later attempts of this job repeat the renewed id; only a new runtime earns another.
      Object.assign(request, { operationId: renewed, delivery: null, fence: null })
      operationId = renewed
    }
    const sent = await guarded(
      job,
      requestTurnStop(host, request, { operationId, fence, turnId: proof.turnId }),
      callTimeoutMs
    )
    if (!here()) {
      return 'done'
    }
    if (!sent.ok) {
      return 'retry'
    }
    if (!sent.value.ok) {
      record({ ...request, operationId }, 'refused', fence)
      return 'done'
    }
    const interrupted =
      sent.value.value.cancelled ||
      (await ownTurnEnded(host, request, job.controller.signal, callTimeoutMs))
    if (!here()) {
      return 'done'
    }
    if (!interrupted) {
      // The host answered but interrupted nothing while the turn still runs: not a stop.
      record({ ...request, operationId }, 'refused', fence)
      follow(request)
      return 'done'
    }
    record({ ...request, operationId }, 'accepted', fence)
    follow(request)
    return 'done'
  }

  async function run(request: RunCancelRequest, job: Job): Promise<void> {
    while (live() && jobs.get(request.runId) === job) {
      if ((await attempt(request, job)) === 'done') {
        return
      }
      job.attempts += 1
      if (job.attempts >= maxAttempts) {
        if (live() && jobs.get(request.runId) === job) {
          const current = listOpenRunCancelRequests(ledger.ledgerContext(), { replay: true }).find(
            (open) => open.runId === request.runId
          )
          record(current ?? request, 'unreachable', null)
          if (job.unproven) {
            waiter.park({ runId: request.runId, sessionId: request.sessionId }, job.host)
          }
        }
        return
      }
      await pause(job, retryDelayMs * job.attempts)
    }
  }

  function start(request: RunCancelRequest): void {
    const job: Job = {
      controller: new AbortController(),
      attempts: 0,
      host: null,
      unproven: false,
      nudge: null
    }
    jobs.set(request.runId, job)
    const task: Promise<void> = run(request, job)
      .catch((error: unknown) => {
        if (live()) {
          console.warn('[forge-inbox] stopping a dispatched run failed', forgeErrorLabel(error))
        }
      })
      .finally(() => {
        if (jobs.get(request.runId) === job) {
          jobs.delete(request.runId)
        }
        running.delete(task)
      })
    running.add(task)
  }

  function wake(options: { replay?: boolean } = {}): void {
    if (!live()) {
      return
    }
    pruneSettledWaits()
    let requests: RunCancelRequest[]
    try {
      requests = listOpenRunCancelRequests(ledger.ledgerContext(), {
        replay: options.replay === true
      })
    } catch (error) {
      console.warn('[forge-inbox] reading stop requests failed', forgeErrorLabel(error))
      return
    }
    for (const request of requests) {
      if (eligible(request)) {
        start(request)
      }
    }
  }

  /** A wait outlives its run only until the next ledger commit, which a settlement always is. */
  function pruneSettledWaits(): void {
    if (waiter.waitingRunIds().length > 0) {
      waiter.retainOnly(
        new Set(
          listOpenRunCancelRequests(ledger.ledgerContext(), { replay: true }).map((r) => r.runId)
        )
      )
    }
  }

  function supersedeJobs(): void {
    for (const job of jobs.values()) {
      job.controller.abort()
    }
    jobs.clear()
    settled.clear()
    waiter.clear()
  }

  const unsubscribe = [
    ledger.onCommitted(() => wake()),
    runtime.onHostChanged(() => {
      supersedeJobs()
      wake({ replay: true })
    })
  ]
  queueMicrotask(() => wake({ replay: true }))

  return {
    wake,
    stop() {
      if (!stopped) {
        stopped = true
        supersedeJobs()
        for (const release of unsubscribe) {
          release()
        }
      }
      return Promise.allSettled(running).then(() => undefined)
    }
  }
}
