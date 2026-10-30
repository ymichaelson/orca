import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { recordDispatchCapture } from './forge-inbox-dispatch-confirmation'
import { parseDispatchReport } from './forge-inbox-dispatch-report'
import { dispatchResultFromTurnText } from './forge-inbox-dispatch-result-summary'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import type { ForgeRun } from './forge-inbox-types'
import {
  markQuestionPreparationUnproven,
  settleQuestionPreparation
} from './forge-inbox-project-event-question-preparation'
import {
  FORGE_RUN_SETTLEMENT_BY_TURN_OUTCOME,
  terminalOutcomeOf
} from './forge-run-turn-settlement'
import {
  markForgeRunUnverifiableIfRunning,
  readForgeRun,
  settleInterruptedForgeRunFromProof,
  transitionForgeRun
} from './forge-inbox-runs'

export type ProjectEventRunWatchOptions = {
  /** The turn may already have ended with no event left to come, so read its proof at registration. */
  proveNow?: boolean
  /** The only run a question preparation may launch; a proof from any other run is never its own. */
  exclusiveRunId?: number
}

export type ProjectEventRunWatch = {
  watch(
    sessionId: string,
    runId: number,
    clientMessageId: string,
    options?: ProjectEventRunWatchOptions
  ): void
  dispose(): void
  /** True once the watch ended itself (feed end, closed ledger); a holder must build a fresh one. */
  isDisposed: () => boolean
}

const PROOF_READ_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 500

type WatchedDispatch = {
  /** The run that owns this session's turn; a later registration for another run on it never reads. */
  exclusiveRunId: number | null
  sessionId: string
  clientMessageId: string
  outcome: AgentJournalTurnOutcome | null
  /** The proof that named the outcome; its text carries the agent's final report. */
  proof: ForgeProtectedTurnProof | null
  reading: boolean
  dirty: boolean
  attempts: number
  exhausted: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function isOpenRun(run: ForgeRun | null): boolean {
  return (
    run?.state === 'running' || (run?.state === 'unverifiable' && run.error === 'unknown-outcome')
  )
}

export function createForgeProjectEventRunWatch(deps: {
  ledger: ForgeInboxLedger
  readTurnProof: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ForgeProtectedTurnProof | null>
  subscribeTurnCompletions: (subscriber: {
    id: string
    emit: (event: AgentSessionTurnCompletionEvent) => void
  }) => () => void
  retryDelayMs?: number
  /** The declined question's minimum task; without one the person is asked directly. */
}): ProjectEventRunWatch {
  const runs = new Map<number, WatchedDispatch>()
  let unsubscribe: (() => void) | null = null
  let disposed = false

  function forget(runId: number, tracked: WatchedDispatch): void {
    if (tracked.timer !== null) {
      clearTimeout(tracked.timer)
    }
    runs.delete(runId)
  }

  function dispose(): void {
    if (disposed) {
      return
    }
    disposed = true
    const drop = unsubscribe
    unsubscribe = null
    for (const [runId, tracked] of runs) {
      if (!deps.ledger.isClosed()) {
        try {
          markForgeRunUnverifiableIfRunning(deps.ledger.ledgerContext(), runId)
        } catch {
          // Startup resumes these as interrupted.
        }
      }
      forget(runId, tracked)
    }
    drop?.()
  }

  function current(runId: number, tracked: WatchedDispatch): boolean {
    return !disposed && !deps.ledger.isClosed() && runs.get(runId) === tracked
  }

  function retryLater(runId: number, tracked: WatchedDispatch): void {
    if (tracked.timer !== null || !current(runId, tracked)) {
      return
    }
    if (tracked.attempts >= MAX_ATTEMPTS) {
      if (!tracked.exhausted) {
        tracked.exhausted = true
        let preparation = false
        if (!deps.ledger.isClosed()) {
          try {
            preparation = markQuestionPreparationUnproven(deps.ledger.ledgerContext(), runId)
          } catch {
            // The next turn event or restart still retains the run and its turn identity.
          }
        }
        console.warn(
          preparation
            ? '[forge-inbox] a question preparation is still unproven; waiting for its late turn proof'
            : '[forge-inbox] a dispatched run is still unproven; waiting for its next turn event'
        )
      }
      return
    }
    tracked.attempts += 1
    tracked.timer = setTimeout(
      () => {
        tracked.timer = null
        void prove(runId, tracked)
      },
      (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * tracked.attempts
    )
    tracked.timer.unref?.()
  }

  function captureReport(ctx: ForgeLedgerContext, runId: number, tracked: WatchedDispatch): void {
    if (tracked.proof !== null) {
      recordDispatchCapture(ctx, runId, {
        sessionId: tracked.sessionId,
        clientMessageId: tracked.clientMessageId,
        turnId: tracked.proof.turnId,
        report: parseDispatchReport(tracked.proof.text)
      })
    }
  }

  /** Only this run's proven outcome replaces the verdict, whatever state it is in. */
  function settle(runId: number, tracked: WatchedDispatch, outcome: AgentJournalTurnOutcome): void {
    const ctx = deps.ledger.ledgerContext()
    const settlement = FORGE_RUN_SETTLEMENT_BY_TURN_OUTCOME[outcome]
    const proof = tracked.proof
    try {
      if (proof) {
        const settled = settleQuestionPreparation(
          ctx,
          runId,
          tracked.sessionId,
          tracked.clientMessageId,
          proof
        )
        if (settled) {
          forget(runId, tracked)
          return
        }
      }
      const run = readForgeRun(ctx, runId)
      if (run?.state === 'running') {
        captureReport(ctx, runId, tracked)
        const summary = dispatchResultFromTurnText(tracked.proof?.text ?? null)
        const result = transitionForgeRun(ctx, runId, {
          to: settlement.to,
          expectedGeneration: run.generation,
          ...(summary === null ? {} : { result: summary }),
          ...(settlement.error === null ? {} : { error: settlement.error })
        })
        if (!result.ok && result.reason === 'generation-mismatch') {
          retryLater(runId, tracked)
          return
        }
      } else if (run?.state === 'unverifiable' && run.error === 'unknown-outcome') {
        captureReport(ctx, runId, tracked)
        settleInterruptedForgeRunFromProof(ctx, runId, {
          ...settlement,
          result: dispatchResultFromTurnText(tracked.proof?.text ?? null)
        })
      }
      // Any other state means someone else already decided this run.
      forget(runId, tracked)
    } catch {
      retryLater(runId, tracked)
    }
  }

  async function readProof(tracked: WatchedDispatch): Promise<ForgeProtectedTurnProof | null> {
    try {
      const read = deps.readTurnProof(tracked.sessionId, tracked.clientMessageId)
      return await withTimeout(read, PROOF_READ_TIMEOUT_MS, null)
    } catch {
      // A failed read is unknown, never evidence about another turn.
      return null
    }
  }

  async function prove(runId: number, tracked: WatchedDispatch): Promise<void> {
    if (!current(runId, tracked)) {
      return
    }
    if (tracked.exclusiveRunId === null && ownedBy(tracked.sessionId, runId)) {
      return
    }
    if (tracked.reading) {
      tracked.dirty = true
      return
    }
    tracked.reading = true
    try {
      do {
        tracked.dirty = false
        if (tracked.outcome === null) {
          const proof = await readProof(tracked)
          tracked.outcome = terminalOutcomeOf(proof)
          tracked.proof = tracked.outcome === null ? null : proof
        }
      } while (tracked.dirty && tracked.outcome === null && current(runId, tracked))
    } finally {
      tracked.reading = false
    }
    if (!current(runId, tracked)) {
      return
    }
    if (tracked.outcome === null) {
      retryLater(runId, tracked)
    } else {
      settle(runId, tracked, tracked.outcome)
    }
  }

  function ownedBy(sessionId: string, runId: number): boolean {
    for (const [ownerRunId, owner] of runs) {
      if (owner.exclusiveRunId !== null && owner.sessionId === sessionId && ownerRunId !== runId) {
        return true
      }
    }
    return false
  }

  function emit(event: AgentSessionTurnCompletionEvent): void {
    if (disposed) {
      return
    }
    if (deps.ledger.isClosed() || event.type === 'end') {
      dispose()
      return
    }
    if (event.type !== 'completion') {
      return
    }
    for (const [runId, tracked] of runs) {
      if (tracked.sessionId !== event.completion.sessionId) {
        continue
      }
      if (tracked.exclusiveRunId === null && ownedBy(tracked.sessionId, runId)) {
        continue
      }
      tracked.attempts = 0
      tracked.exhausted = false
      void prove(runId, tracked)
    }
  }

  return {
    watch(sessionId, runId, clientMessageId, options) {
      if (disposed || deps.ledger.isClosed()) {
        return
      }
      const run = readForgeRun(deps.ledger.ledgerContext(), runId)
      if (!isOpenRun(run)) {
        return
      }
      const exclusiveRunId = options?.exclusiveRunId ?? null
      if (exclusiveRunId !== null && ownedBy(sessionId, runId)) {
        return
      }
      const previous = runs.get(runId)
      if (previous) {
        forget(runId, previous)
      }
      const tracked: WatchedDispatch = {
        exclusiveRunId,
        sessionId,
        clientMessageId,
        outcome: null,
        proof: null,
        reading: false,
        dirty: false,
        attempts: 0,
        exhausted: false,
        timer: null
      }
      runs.set(runId, tracked)
      if (unsubscribe === null) {
        unsubscribe = deps.subscribeTurnCompletions({ id: 'forge-project-event-runs', emit })
      }
      if (options?.proveNow) {
        void prove(runId, tracked)
      }
    },
    dispose,
    isDisposed: () => disposed
  }
}
