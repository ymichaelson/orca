import type {
  RuntimeTerminalSummary,
  RuntimeTerminalWait
} from '../../shared/runtime-terminal-contracts'
import { boundedCall } from './forge-inbox-bounded-call'
import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { recordRunCancelDelivery } from './forge-inbox-project-event-run-cancel-state'
import {
  listOpenTerminalRuns,
  recordRunTerminalExit,
  refreshRunTerminalHandle,
  type OpenTerminalRun
} from './forge-inbox-project-event-run-terminal-state'
import { resolveRunTerminal, terminalExitFact } from './forge-inbox-project-event-terminal-identity'

/** Only what observing and stopping a launched terminal reads of the runtime. */
export type ProjectEventTerminalRuntime = {
  waitForTerminal(
    handle: string,
    options: { condition: 'exit'; signal: AbortSignal }
  ): Promise<Pick<RuntimeTerminalWait, 'status' | 'satisfied' | 'exitCode' | 'exitCause'>>
  closeTerminal(handle: string): Promise<unknown>
  /** Never starts a terminal: it only names the ones that already exist. */
  listTerminals(
    worktreeSelector: string,
    limit: number,
    options: { requireFreshPtyLiveness: true }
  ): Promise<{
    terminals: readonly Pick<
      RuntimeTerminalSummary,
      'handle' | 'ptyId' | 'incarnationId' | 'executionHostId' | 'orphaned'
    >[]
  }>
}

export type ProjectEventTerminalObserver = {
  wake(): void
  /** Fences every later effect at once; resolves when the waits and stops it started have ended. */
  stop(): Promise<void>
}

export type ProjectEventTerminalObserverDeps = {
  ledger: ForgeInboxLedger
  runtime: ProjectEventTerminalRuntime
  retryDelayMs?: number
  maxAttempts?: number
  callTimeoutMs?: number
  /** How long a run the observer gave up on is left alone before a later commit may try it again. */
  giveUpCooldownMs?: number
}

const DEFAULT_RETRY_DELAY_MS = 2_000
const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_CALL_TIMEOUT_MS = 10_000
const DEFAULT_GIVE_UP_COOLDOWN_MS = 60_000

type Job = { controller: AbortController; waiting: boolean; stopping: boolean }

/**
 * Watches each dispatched terminal's own process and closes it when a policy change asked for a stop.
 * It never launches, sends or reads a terminal: every action is on a terminal re-proven to still be
 * the exact PTY the launch returned, and a close receipt is not an exit.
 */
export function createForgeProjectEventTerminalObserver(
  deps: ProjectEventTerminalObserverDeps
): ProjectEventTerminalObserver {
  const { ledger, runtime } = deps
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const giveUpCooldownMs = deps.giveUpCooldownMs ?? DEFAULT_GIVE_UP_COOLDOWN_MS
  const gaveUpAt = new Map<number, number>()
  const jobs = new Map<number, Job>()
  const running = new Set<Promise<void>>()
  let stopped = false

  const live = (): boolean => !stopped && !ledger.isClosed()

  async function stopTerminal(run: OpenTerminalRun, job: Job): Promise<void> {
    // A stop outlives the wait it rides on: the exit it causes ends the job before the close returns.
    const here = (): boolean => live() && !job.controller.signal.aborted
    const found = await resolveRunTerminal(
      runtime,
      run.identity,
      job.controller.signal,
      callTimeoutMs
    )
    if (!here() || run.cancelOperationId === null) {
      return
    }
    const request = { runId: run.runId, itemId: run.itemId, operationId: run.cancelOperationId }
    if (found.kind !== 'found') {
      // Not provably the terminal it started, so nothing is closed.
      recordRunCancelDelivery(ledger.ledgerContext(), request, 'unreachable', null)
      return
    }
    // The lookup's handle is used in the same turn it was found, with no await between.
    const closed = await boundedCall(
      job.controller.signal,
      runtime.closeTerminal(found.handle),
      callTimeoutMs
    )
    if (here()) {
      recordRunCancelDelivery(
        ledger.ledgerContext(),
        request,
        closed.ok ? 'accepted' : 'refused',
        null
      )
    }
  }

  function maybeStop(runId: number, job: Job): void {
    if (!job.waiting || job.stopping || !live()) {
      return
    }
    const run = listOpenTerminalRuns(ledger.ledgerContext()).find((open) => open.runId === runId)
    if (!run || run.cancelOperationId === null || run.cancelDelivery !== null) {
      return
    }
    job.stopping = true
    track(
      stopTerminal(run, job).finally(() => {
        job.stopping = false
      })
    )
  }

  function track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((error: unknown) => {
        if (live()) {
          console.warn('[forge-inbox] a terminal stop failed', forgeErrorLabel(error))
        }
      })
      .finally(() => running.delete(tracked))
    running.add(tracked)
  }

  /** A stop that was asked for and can no longer be acted on is reported, never left pending. */
  function giveUp(runId: number, job: Job): void {
    if (!live() || jobs.get(runId) !== job) {
      return
    }
    gaveUpAt.set(runId, Date.now())
    const run = listOpenTerminalRuns(ledger.ledgerContext()).find((open) => open.runId === runId)
    if (run && run.cancelOperationId !== null && run.cancelDelivery === null) {
      const request = { runId, itemId: run.itemId, operationId: run.cancelOperationId }
      recordRunCancelDelivery(ledger.ledgerContext(), request, 'unreachable', null)
    }
  }

  async function observeRun(run: OpenTerminalRun, job: Job): Promise<void> {
    const here = (): boolean => live() && jobs.get(run.runId) === job
    try {
      await watchRun(run, job, here)
    } finally {
      giveUp(run.runId, job)
    }
  }

  async function watchRun(run: OpenTerminalRun, job: Job, here: () => boolean): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts && here(); attempt++) {
      const found = await resolveRunTerminal(
        runtime,
        run.identity,
        job.controller.signal,
        callTimeoutMs
      )
      if (!here() || found.kind === 'unprovable') {
        return
      }
      if (found.kind === 'found') {
        if (found.handle !== run.identity.handle) {
          refreshRunTerminalHandle(ledger.ledgerContext(), run.runId, found.handle)
        }
        const waited = runtime
          .waitForTerminal(found.handle, { condition: 'exit', signal: job.controller.signal })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error })
          )
        job.waiting = true
        maybeStop(run.runId, job)
        // Raced with the abort, so a runtime that ignores the signal still cannot hold a shutdown.
        const raced = await boundedCall(job.controller.signal, waited, null)
        job.waiting = false
        if (!here() || !raced.ok) {
          return
        }
        const result = raced.value
        if (result.ok) {
          const exit = terminalExitFact(result.value)
          if (exit) {
            recordRunTerminalExit(ledger.ledgerContext(), run, exit)
          }
          return
        }
        if (!(result.error instanceof Error && result.error.message === 'terminal_handle_stale')) {
          return
        }
      }
      await boundedCall(
        job.controller.signal,
        new Promise<never>(() => undefined),
        retryDelayMs * attempt
      )
    }
  }

  function start(run: OpenTerminalRun): void {
    const job: Job = { controller: new AbortController(), waiting: false, stopping: false }
    jobs.set(run.runId, job)
    track(
      observeRun(run, job).finally(() => {
        if (jobs.get(run.runId) === job) {
          jobs.delete(run.runId)
        }
      })
    )
  }

  function wake(): void {
    if (!live()) {
      return
    }
    let open: OpenTerminalRun[]
    try {
      open = listOpenTerminalRuns(ledger.ledgerContext())
    } catch (error) {
      console.warn('[forge-inbox] reading dispatched terminals failed', forgeErrorLabel(error))
      return
    }
    for (const run of open) {
      const gaveUp = gaveUpAt.get(run.runId)
      if (gaveUp !== undefined && Date.now() - gaveUp < giveUpCooldownMs) {
        // A stop asked for after the observer gave up has no one left to send it.
        if (run.cancelOperationId !== null && run.cancelDelivery === null) {
          const request = {
            runId: run.runId,
            itemId: run.itemId,
            operationId: run.cancelOperationId
          }
          recordRunCancelDelivery(ledger.ledgerContext(), request, 'unreachable', null)
        }
        continue
      }
      const job = jobs.get(run.runId)
      if (job) {
        maybeStop(run.runId, job)
      } else {
        start(run)
      }
    }
  }

  const release = ledger.onCommitted(() => wake())
  queueMicrotask(wake)

  return {
    wake,
    stop() {
      if (!stopped) {
        stopped = true
        release()
        for (const job of jobs.values()) {
          job.controller.abort()
        }
        jobs.clear()
      }
      return Promise.allSettled(running).then(() => undefined)
    }
  }
}
