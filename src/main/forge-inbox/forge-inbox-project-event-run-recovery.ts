import { withTimeout } from '../../shared/promise-timeout-fallback'
import { recordDispatchCapture } from './forge-inbox-dispatch-confirmation'
import { parseDispatchReport } from './forge-inbox-dispatch-report'
import { dispatchResultFromTurnText } from './forge-inbox-dispatch-result-summary'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { settleQuestionPreparation } from './forge-inbox-project-event-question-preparation'
import {
  FORGE_RUN_SETTLEMENT_BY_TURN_OUTCOME,
  terminalOutcomeOf
} from './forge-run-turn-settlement'
import {
  listInterruptedDispatchedForgeRuns,
  settleInterruptedForgeRunFromProof
} from './forge-inbox-runs'

export type ProjectEventRunRecoveryDeps = {
  ledger: ForgeInboxLedger
  /** Null means this host cannot prove a turn, so the recorded verdict stands. */
  readTurnProof: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ForgeProtectedTurnProof | null>
  /** False once the caller no longer owns the ledger or host, so a late proof writes nothing. */
  isCurrent?: () => boolean
  /** Caps the whole pass, not each read, so a host that never answers cannot stall its caller. */
  totalTimeoutMs?: number
  readTimeoutMs?: number
}

const PROOF_READ_TIMEOUT_MS = 5_000
const TOTAL_TIMEOUT_MS = 10_000

/** A dead process's dispatched runs ask their own journal turn; anything unprovable is left alone. */
export async function recoverInterruptedProjectEventRuns(
  deps: ProjectEventRunRecoveryDeps
): Promise<{ recovered: number; unproven: number }> {
  const candidates = listInterruptedDispatchedForgeRuns(deps.ledger.ledgerContext())
  let recovered = 0
  let unproven = 0
  const deadline = Date.now() + (deps.totalTimeoutMs ?? TOTAL_TIMEOUT_MS)
  for (const candidate of candidates) {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || (deps.isCurrent && !deps.isCurrent())) {
      unproven += 1
      continue
    }
    let proof: ForgeProtectedTurnProof | null
    try {
      proof = await withTimeout(
        deps.readTurnProof(candidate.sessionId, candidate.clientMessageId),
        Math.min(deps.readTimeoutMs ?? PROOF_READ_TIMEOUT_MS, remaining),
        null
      )
    } catch (error) {
      // A throwing journal is the same as an unanswered one: the run keeps its recorded verdict.
      console.warn(
        '[forge-inbox] reading a dispatched run proof failed',
        error instanceof Error ? error.name : 'unknown'
      )
      unproven += 1
      continue
    }
    if (deps.isCurrent && !deps.isCurrent()) {
      break
    }
    const outcome = terminalOutcomeOf(proof)
    const preparation =
      proof !== null && outcome !== null
        ? settleQuestionPreparation(
            deps.ledger.ledgerContext(),
            candidate.id,
            candidate.sessionId,
            candidate.clientMessageId,
            proof
          )
        : false
    if (preparation) {
      // A question preparation proves itself here; no ordinary settlement may overwrite that verdict.
      recovered += 1
      continue
    }
    const settlement = outcome === null ? null : FORGE_RUN_SETTLEMENT_BY_TURN_OUTCOME[outcome]
    if (proof !== null && outcome !== null) {
      recordDispatchCapture(deps.ledger.ledgerContext(), candidate.id, {
        sessionId: candidate.sessionId,
        clientMessageId: candidate.clientMessageId,
        turnId: proof.turnId,
        report: parseDispatchReport(proof.text)
      })
    }
    if (
      settlement === null ||
      !settleInterruptedForgeRunFromProof(deps.ledger.ledgerContext(), candidate.id, {
        ...settlement,
        result: dispatchResultFromTurnText(proof?.text ?? null)
      })
    ) {
      unproven += 1
      continue
    }
    recovered += 1
  }
  return { recovered, unproven }
}
