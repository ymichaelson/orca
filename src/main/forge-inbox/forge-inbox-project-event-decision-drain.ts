import type {
  ProjectEventDecisionInput,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery,
  getProjectEventDecisionSchedule
} from './forge-inbox-project-event-decision'

const MAX_PER_DRAIN = 8

export type ProjectEventDecisionDrain = { decided: number; failed: number; capped: boolean }

export async function drainProjectEventDecisions(
  ctx: ForgeLedgerContext,
  decide: (
    input: ProjectEventDecisionInput,
    signal?: AbortSignal
  ) => Promise<ProjectEventDecisionResult>,
  signal?: AbortSignal
): Promise<ProjectEventDecisionDrain> {
  const result = { decided: 0, failed: 0, capped: false }
  for (let processed = 0; processed < MAX_PER_DRAIN && !signal?.aborted; processed += 1) {
    const schedule = getProjectEventDecisionSchedule(ctx)
    if (schedule.nextAttemptAtMs === null || schedule.nextAttemptAtMs > ctx.now()) {
      break
    }
    const claim = claimProjectEventDecision(ctx)
    if (!claim) {
      continue
    }
    let decision: ProjectEventDecisionResult
    try {
      decision = await decide(claim.input, signal)
    } catch {
      decision = { ok: false, code: 'network' }
    }
    // Shutdown joins this work before closing SQLite; an ignored abort cannot write late results.
    if (signal?.aborted) {
      return result
    }
    const recorded = decideProjectEventDelivery(ctx, claim.deliveryId, decision, claim)
    if (recorded.ok) {
      result.decided += 1
    } else {
      result.failed += 1
    }
  }
  const schedule = getProjectEventDecisionSchedule(ctx)
  result.capped =
    !signal?.aborted && schedule.nextAttemptAtMs !== null && schedule.nextAttemptAtMs <= ctx.now()
  return result
}
