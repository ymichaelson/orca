import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { ingestForgeEventInTransaction } from './forge-inbox-ingest'
import { readForgeItemWatermark } from './forge-inbox-item-watermark'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import type { ForgeEventIngest, ForgeIngestResult } from './forge-inbox-types'

export type ForgeObservationInput = Omit<ForgeEventIngest, 'sourceOrder'>

export type ForgeObservationResult =
  | ({ ok: true } & ForgeIngestResult)
  | { ok: false; reason: 'stale-config' | 'dirty-observation' }

/** Allocates verified order only when both config and raw invalidation fences still match. */
export function ingestForgeObservation(
  ctx: ForgeLedgerContext,
  input: ForgeObservationInput,
  expectedConfigRevision: number,
  expectedInvalidationGeneration: number
): ForgeObservationResult {
  return runForgeTransaction(ctx.db, (): ForgeObservationResult => {
    if (readForgeConfigState(ctx).revision !== expectedConfigRevision) {
      return { ok: false, reason: 'stale-config' }
    }
    if (readForgeProjectInvalidationGeneration(ctx, input) !== expectedInvalidationGeneration) {
      return { ok: false, reason: 'dirty-observation' }
    }
    const watermark = readForgeItemWatermark(ctx, input)
    // Queueing itself refuses a head that already carries a claim, so a repeated delivery of the
    // same context records history without starting or paying for another analysis.
    const result = ingestForgeEventInTransaction(ctx, {
      ...input,
      sourceOrder: (watermark?.headOrder ?? 0) + 1
    })
    return { ok: true, ...result }
  })
}
