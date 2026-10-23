import type {
  ForgeAnalysisResult,
  ForgeInstanceScope,
  ForgeRun
} from '../../shared/forge-inbox-types'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeRunTransition } from './forge-inbox-runs'
import { isRecord } from './forge-inbox-rows'

/** The adapter may only report an outcome it can prove; anything else is left to reconciliation. */
export type ForgeAnalysisOutcome =
  | {
      kind: 'analysed'
      result: ForgeAnalysisResult
      /** The head an approval must still match; present only for a draft that can become a comment. */
      commentDraft?: { headSha: string | null }
    }
  | { kind: 'unknown' }

export type ForgeAnalysisContext = {
  run: ForgeRun
  signal: AbortSignal
  /** Durable before the first message is sent, so a restart resumes instead of re-paying. */
  bindSession: (sessionId: string) => void
}

export type ForgeAnalysisRunner = (context: ForgeAnalysisContext) => Promise<ForgeAnalysisOutcome>

export type ForgeCoordinatorLimits = {
  maxConcurrentRuns?: number
  maxSummaryChars?: number
  runBudgetMs?: number
}

export type ForgeDrainResult = {
  analysed: number
  failed: number
  unverifiable: number
  cancelled: number
}

export const FORGE_COORDINATOR_DEFAULTS = {
  maxConcurrentRuns: 2,
  maxSummaryChars: 8000,
  runBudgetMs: 10 * 60_000
} as const

type Settled =
  | { settled: true; outcome: ForgeAnalysisOutcome }
  | { settled: true; failure: true }
  | { settled: false }

export function createForgeInboxCoordinator(deps: {
  ledger: ForgeInboxLedger
  scope: ForgeInstanceScope
  analyse: ForgeAnalysisRunner
  /** Records a succeeded run's draft as a pending approval; publishing still needs an explicit one. */
  proposeComment?: (input: { run: ForgeRun; headSha: string | null; body: string }) => void
  limits?: ForgeCoordinatorLimits
}): { drainOnce(stopping?: AbortSignal): Promise<ForgeDrainResult> } {
  const { ledger, scope, analyse, proposeComment } = deps
  const limits = { ...FORGE_COORDINATOR_DEFAULTS, ...deps.limits }

  return {
    /** Runs whatever is runnable now; each run settles before the next is claimed. */
    async drainOnce(stopping?: AbortSignal): Promise<ForgeDrainResult> {
      const counts: ForgeDrainResult = { analysed: 0, failed: 0, unverifiable: 0, cancelled: 0 }
      while (stopping?.aborted !== true) {
        ledger.supersedeStaleRuns(scope)
        ledger.cancelRevokedRuns(scope)
        const run = ledger.claimNextRunnableRun(scope, {
          maxConcurrentRuns: limits.maxConcurrentRuns
        })
        if (!run) {
          break
        }
        counts[await settle(ledger, analyse, limits, proposeComment, run, stopping)] += 1
      }
      return { ...counts }
    }
  }
}

async function settle(
  ledger: ForgeInboxLedger,
  analyse: ForgeAnalysisRunner,
  limits: Required<ForgeCoordinatorLimits>,
  proposeComment:
    | ((input: { run: ForgeRun; headSha: string | null; body: string }) => void)
    | undefined,
  run: ForgeRun,
  stopping: AbortSignal | undefined
): Promise<keyof ForgeDrainResult> {
  const controller = new AbortController()
  let stopRequested = stopping?.aborted === true
  let budgetExpired = false
  const onStop = (): void => {
    stopRequested = true
    controller.abort()
  }
  stopping?.addEventListener('abort', onStop, { once: true })
  const timer = setTimeout(() => {
    budgetExpired = true
    controller.abort()
  }, limits.runBudgetMs)

  const bindSession = (sessionId: string): void => {
    if (controller.signal.aborted) {
      return
    }
    ledger.bindRunSession(run.id, sessionId)
  }

  let settled: Settled
  try {
    settled = await Promise.race([
      analyse({ run, signal: controller.signal, bindSession }).then(
        (outcome): Settled => ({ settled: true, outcome }),
        (): Settled => ({ settled: true, failure: true })
      ),
      abortSignal(controller.signal).then((): Settled => ({ settled: false }))
    ])
  } finally {
    clearTimeout(timer)
    stopping?.removeEventListener('abort', onStop)
  }

  if (stopRequested) {
    return transition(ledger, run, { to: 'cancelled', error: 'owner-stopped' })
  }
  if (!settled.settled || budgetExpired) {
    return transition(ledger, run, { to: 'unverifiable', error: 'unknown-outcome' })
  }
  if ('failure' in settled) {
    return transition(ledger, run, { to: 'failed', error: 'analysis-failed' })
  }
  if (settled.outcome.kind === 'unknown') {
    return transition(ledger, run, { to: 'unverifiable', error: 'unknown-outcome' })
  }
  // The rules that paid for this run are re-checked before anything produced under them persists.
  if (!ledger.runPolicyIsCurrent(run.id)) {
    return transition(ledger, run, { to: 'cancelled', error: 'policy-revoked' })
  }
  const verdict = checkResult(settled.outcome.result, limits.maxSummaryChars)
  if (verdict !== 'ok') {
    return transition(ledger, run, {
      to: 'failed',
      error: verdict === 'too-large' ? 'output-budget' : 'analysis-failed'
    })
  }
  // A result with no bound session cannot be discussed or reconciled, so it is not a success.
  const sessionId = ledger.getRun(run.id)?.sessionId ?? null
  if (sessionId === null) {
    return transition(ledger, run, { to: 'failed', error: 'analysis-failed' })
  }
  const { commentDraft, result } = settled.outcome
  const { draft } = result
  if (commentDraft !== undefined && draft !== undefined && proposeComment !== undefined) {
    try {
      // Before settlement so the proposal is written while the run is still claimable as running.
      proposeComment({ run, headSha: commentDraft.headSha, body: draft })
    } catch {
      // The stored result still stands; only the optional approval is missing.
    }
  }
  return transition(ledger, run, {
    to: 'succeeded',
    sessionId,
    result: settled.outcome.result
  })
}

function transition(
  ledger: ForgeInboxLedger,
  run: ForgeRun,
  change: ForgeRunTransition
): keyof ForgeDrainResult {
  if (ledger.transitionRun(run.id, { ...change, expectedGeneration: run.generation }).ok) {
    return outcomeKey(change.to)
  }
  // Something else already moved the run; report what it actually became.
  return outcomeKey(ledger.getRun(run.id)?.state)
}

function outcomeKey(state: ForgeRunTransition['to'] | undefined): keyof ForgeDrainResult {
  if (state === 'succeeded') {
    return 'analysed'
  }
  if (state === 'failed') {
    return 'failed'
  }
  return state === 'cancelled' || state === 'superseded' ? 'cancelled' : 'unverifiable'
}

function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** Adapter output is untrusted even when typed: the shape is re-checked at the ledger boundary. */
function checkResult(
  result: ForgeAnalysisResult,
  maxChars: number
): 'ok' | 'malformed' | 'too-large' {
  if (!isRecord(result) || typeof result.summary !== 'string' || !Array.isArray(result.concerns)) {
    return 'malformed'
  }
  const concerns = result.concerns
  if (!concerns.every((concern: unknown) => typeof concern === 'string')) {
    return 'malformed'
  }
  const draft = result.draft
  if (draft !== undefined && typeof draft !== 'string') {
    return 'malformed'
  }
  const texts = [result.summary, ...concerns]
  if (typeof draft === 'string') {
    texts.push(draft)
  }
  return texts.some((text) => text.length > maxChars) ? 'too-large' : 'ok'
}
