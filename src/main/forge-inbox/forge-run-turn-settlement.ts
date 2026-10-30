import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import type { ForgeRunState } from '../../shared/forge-inbox-types'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'

export const FORGE_RUN_SETTLEMENT_BY_TURN_OUTCOME: Readonly<
  Record<AgentJournalTurnOutcome, { to: ForgeRunState; error: string | null }>
> = {
  success: { to: 'succeeded', error: null },
  failure: { to: 'failed', error: 'agent-failure' },
  cancellation: { to: 'cancelled', error: 'cancelled' },
  superseded: { to: 'cancelled', error: 'superseded' }
}

/** Only a finished original turn names a verdict; a running or unprovable one names none. */
export function terminalOutcomeOf(
  proof: ForgeProtectedTurnProof | null
): AgentJournalTurnOutcome | null {
  return proof?.terminal && proof.outcome !== null ? proof.outcome : null
}
