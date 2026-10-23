import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber, runFromRow } from './forge-inbox-rows'
import type {
  ForgeAnalysisResult,
  ForgeRun,
  ForgeRunState,
  ForgeInstanceScope
} from './forge-inbox-types'

const ALLOWED_TRANSITIONS: Record<ForgeRunState, readonly ForgeRunState[]> = {
  queued: ['running', 'cancelled', 'superseded'],
  running: ['awaiting-approval', 'succeeded', 'failed', 'cancelled', 'unverifiable'],
  'awaiting-approval': ['running', 'succeeded', 'failed', 'cancelled', 'unverifiable'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unverifiable: [],
  superseded: []
}

export type ForgeRunTransitionResult =
  | { ok: true; run: ForgeRun }
  | { ok: false; reason: 'not-found' | 'illegal-transition' | 'generation-mismatch' }

export function readForgeRun(ctx: ForgeLedgerContext, runId: number): ForgeRun | null {
  const row = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  return row ? runFromRow(row) : null
}

/** Moves the oldest queued run in scope to running; null when nothing is queued. */
export function claimNextQueuedForgeRun(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope
): ForgeRun | null {
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT r.id FROM runs r JOIN items i ON i.id = r.item_id
         WHERE r.state = 'queued' AND i.host_id = ? AND (? IS NULL OR i.instance_id = ?)
         ORDER BY r.id LIMIT 1`
      )
      .get(ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
    if (!row) {
      return null
    }
    const run = readForgeRun(ctx, rowNumber(row, 'id'))
    if (!run) {
      return null
    }
    const result = applyTransition(ctx, run, { to: 'running' })
    return result.ok ? result.run : null
  })
}

export type ForgeRunTransition = {
  to: ForgeRunState
  expectedGeneration?: number
  error?: string
  /** Omitted keeps what the run already recorded. */
  sessionId?: string | null
  result?: ForgeAnalysisResult | null
}

export function transitionForgeRun(
  ctx: ForgeLedgerContext,
  runId: number,
  change: ForgeRunTransition
): ForgeRunTransitionResult {
  return runForgeTransaction(ctx.db, () => {
    const run = readForgeRun(ctx, runId)
    if (!run) {
      return { ok: false, reason: 'not-found' }
    }
    if (change.expectedGeneration !== undefined && change.expectedGeneration !== run.generation) {
      return { ok: false, reason: 'generation-mismatch' }
    }
    return applyTransition(ctx, run, change)
  })
}

/** Persists the session before anything is sent, so a restart reconciles instead of re-launching. */
export function bindForgeRunSession(
  ctx: ForgeLedgerContext,
  runId: number,
  sessionId: string
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const updated = ctx.db
      .prepare(
        "UPDATE runs SET session_id = ?, updated_at = ? WHERE id = ? AND state = 'running' AND session_id IS NULL"
      )
      .run(sessionId, ctx.now(), runId)
    return updated.changes === 1
  })
}

/** A run left running belongs to a process that is gone; nothing may claim its outcome. */
export function markInterruptedForgeRunsUnverifiable(ctx: ForgeLedgerContext): number {
  return runForgeTransaction(ctx.db, () => interruptedRuns(ctx))
}

function interruptedRuns(ctx: ForgeLedgerContext): number {
  const running = ctx.db
    .prepare(
      `SELECT r.id, r.generation, r.item_id FROM runs r JOIN items i ON i.id = r.item_id
       WHERE r.state = 'running' AND i.host_id = ?`
    )
    .all(ctx.hostId)
  let marked = 0
  for (const row of running) {
    ctx.db
      .prepare(
        "UPDATE runs SET state = 'unverifiable', generation = generation + 1, error = 'unknown-outcome', updated_at = ? WHERE id = ? AND generation = ?"
      )
      .run(ctx.now(), rowNumber(row, 'id'), rowNumber(row, 'generation'))
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'run', rowNumber(row, 'id'), 'unverifiable')
    marked += 1
  }
  return marked
}

export function applyTransition(
  ctx: ForgeLedgerContext,
  run: ForgeRun,
  change: ForgeRunTransition
): ForgeRunTransitionResult {
  if (!ALLOWED_TRANSITIONS[run.state].includes(change.to)) {
    return { ok: false, reason: 'illegal-transition' }
  }
  const sessionId = change.sessionId === undefined ? run.sessionId : change.sessionId
  const result = change.result === undefined ? run.result : change.result
  // Generation is the CAS token: any transition invalidates proposals tied to the old one.
  const updated = ctx.db
    .prepare(
      `UPDATE runs SET state = ?, generation = generation + 1, error = ?, session_id = ?,
         result_json = ?, updated_at = ?
       WHERE id = ? AND generation = ?`
    )
    .run(
      change.to,
      change.error ?? null,
      sessionId,
      result === null ? null : JSON.stringify(result),
      ctx.now(),
      run.id,
      run.generation
    )
  if (updated.changes !== 1) {
    return { ok: false, reason: 'generation-mismatch' }
  }
  recordForgeChange(ctx, run.itemId, 'run', run.id, change.to)
  const next = readForgeRun(ctx, run.id)
  if (!next) {
    throw new Error('forge inbox run vanished inside its transition')
  }
  return { ok: true, run: next }
}
