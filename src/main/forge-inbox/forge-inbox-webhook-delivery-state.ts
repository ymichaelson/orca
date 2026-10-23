import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeWebhookDelivery } from './forge-inbox-webhook-queue'

const MAX_ATTEMPTS = 5
const BASE_RETRY_DELAY_MS = 30_000
const MAX_RETRY_DELAY_MS = 15 * 60_000
const MAX_RETRY_AFTER_MS = 5 * 60_000
// A code is an enum-like token so payload text or exception messages can never be stored.
const ERROR_CODE_PATTERN = /^[a-z0-9-]{1,64}$/

export type ForgeWebhookFailure =
  | { code: string; nowMs: number; terminal?: false; retryAfterMs?: number }
  | { code: string; terminal: true }

export type ForgeWebhookTransition =
  | { ok: true }
  | { ok: false; reason: 'invalid-state' | 'not-found' }

export type ForgeWebhookFailureOutcome =
  | { ok: true; state: 'pending'; retryAtMs: number }
  | { ok: true; state: 'failed' }
  | { ok: false; reason: 'invalid-state' | 'not-found' }

export function forgeWebhookRetryDelayMs(failedAttempts: number): number {
  const exponent = Math.max(failedAttempts - 1, 0)
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.min(exponent, 30), MAX_RETRY_DELAY_MS)
}

function assertSafeNowMs(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error('forge inbox webhook nowMs must be a safe integer')
  }
}

function retryTimestamp(nowMs: number, delayMs: number): number {
  const retryAtMs = nowMs + delayMs
  if (!Number.isSafeInteger(retryAtMs)) {
    throw new Error('forge inbox webhook retry timestamp must be a safe integer')
  }
  return retryAtMs
}

function assertErrorCode(code: string): void {
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new Error('forge inbox webhook error code must match [a-z0-9-]{1,64}')
  }
}

// Finished rows keep only the dedupe key; dropping the body releases its capacity and payload.
export const FORGE_WEBHOOK_CLAIM_SQL = `SELECT * FROM webhook_deliveries
  WHERE host_id = ? AND state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  ORDER BY id LIMIT 1`

export const FORGE_WEBHOOK_PRUNE_SQL = `DELETE FROM webhook_deliveries WHERE id IN (
  SELECT id FROM webhook_deliveries
  WHERE host_id = ? AND state IN ('done', 'failed') AND finished_at IS NOT NULL
    AND finished_at <= ?
  ORDER BY id LIMIT ?)`

const FINISH_SQL = `body = x'', next_attempt_at = NULL, finished_at = ?`

/**
 * A claim schedules its own retry so a worker that dies before marking is not re-offered at once,
 * and a row already at the attempt bound is failed here so a poison body cannot crash-loop.
 */
export function claimNextForgeWebhookDelivery(
  ctx: ForgeLedgerContext,
  nowMs: number
): ForgeWebhookDelivery | null {
  assertSafeNowMs(nowMs)
  return runForgeTransaction(ctx.db, () => {
    for (;;) {
      const row = ctx.db.prepare(FORGE_WEBHOOK_CLAIM_SQL).get(ctx.hostId, nowMs)
      if (!row) {
        return null
      }
      const id = rowNumber(row, 'id')
      const attempts = rowNumber(row, 'attempts')
      if (attempts >= MAX_ATTEMPTS) {
        ctx.db
          .prepare(
            `UPDATE webhook_deliveries SET state = 'failed', last_error_code = 'crash-loop', ${FINISH_SQL}
             WHERE id = ?`
          )
          .run(ctx.now(), id)
        continue
      }
      ctx.db
        .prepare('UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ? WHERE id = ?')
        .run(attempts + 1, retryTimestamp(nowMs, forgeWebhookRetryDelayMs(attempts + 1)), id)
      if (!(row.body instanceof Uint8Array)) {
        throw new Error('forge inbox webhook body is not binary')
      }
      return {
        id,
        instanceId: rowText(row, 'instance_id'),
        projectId: rowText(row, 'project_id'),
        eventKind: rowText(row, 'event_kind'),
        dedupeKey: rowText(row, 'dedupe_key'),
        eventUuid: row.event_uuid === null ? null : rowText(row, 'event_uuid'),
        configUuid: row.config_uuid === null ? null : rowText(row, 'config_uuid'),
        configRevision: rowNumber(row, 'config_revision'),
        admittedAt: rowNumber(row, 'admitted_at'),
        state: 'pending',
        body: Buffer.from(row.body)
      }
    }
  })
}

function rejectedTransition(
  ctx: ForgeLedgerContext,
  id: number
): { ok: false; reason: 'invalid-state' | 'not-found' } {
  const exists = ctx.db
    .prepare('SELECT 1 AS found FROM webhook_deliveries WHERE id = ? AND host_id = ?')
    .get(id, ctx.hostId)
  return { ok: false, reason: exists ? 'invalid-state' : 'not-found' }
}

export function markForgeWebhookDeliveryDone(
  ctx: ForgeLedgerContext,
  id: number
): ForgeWebhookTransition {
  const result = ctx.db
    .prepare(
      `UPDATE webhook_deliveries SET state = 'done', ${FINISH_SQL}
       WHERE id = ? AND host_id = ? AND state IN ('pending', 'needs-auth')`
    )
    .run(ctx.now(), id, ctx.hostId)
  return result.changes === 1 ? { ok: true } : rejectedTransition(ctx, id)
}

export function markForgeWebhookDeliveryFailed(
  ctx: ForgeLedgerContext,
  id: number,
  failure: ForgeWebhookFailure
): ForgeWebhookFailureOutcome {
  assertErrorCode(failure.code)
  if (!failure.terminal) {
    assertSafeNowMs(failure.nowMs)
    if (
      failure.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(failure.retryAfterMs) ||
        failure.retryAfterMs < 0 ||
        failure.retryAfterMs > MAX_RETRY_AFTER_MS)
    ) {
      throw new Error('forge inbox webhook retryAfterMs must be an integer from 0 to 300000')
    }
  }
  return runForgeTransaction(ctx.db, (): ForgeWebhookFailureOutcome => {
    const row = ctx.db
      .prepare(
        "SELECT attempts FROM webhook_deliveries WHERE id = ? AND host_id = ? AND state = 'pending'"
      )
      .get(id, ctx.hostId)
    if (!row) {
      return rejectedTransition(ctx, id)
    }
    const attempts = rowNumber(row, 'attempts')
    if (failure.terminal || attempts >= MAX_ATTEMPTS) {
      ctx.db
        .prepare(
          `UPDATE webhook_deliveries SET state = 'failed', last_error_code = ?, ${FINISH_SQL}
           WHERE id = ?`
        )
        .run(failure.code, ctx.now(), id)
      return { ok: true, state: 'failed' }
    }
    // Honors a server-provided wait only when it is longer than our own backoff.
    const retryAtMs = retryTimestamp(
      failure.nowMs,
      Math.max(forgeWebhookRetryDelayMs(attempts), failure.retryAfterMs ?? 0)
    )
    ctx.db
      .prepare(
        'UPDATE webhook_deliveries SET next_attempt_at = ?, last_error_code = ? WHERE id = ?'
      )
      .run(retryAtMs, failure.code, id)
    return { ok: true, state: 'pending', retryAtMs }
  })
}

export function markForgeWebhookDeliveryNeedsAuth(
  ctx: ForgeLedgerContext,
  id: number
): ForgeWebhookTransition {
  const result = ctx.db
    .prepare(
      `UPDATE webhook_deliveries SET state = 'needs-auth', next_attempt_at = NULL
       WHERE id = ? AND host_id = ? AND state = 'pending'`
    )
    .run(id, ctx.hostId)
  return result.changes === 1 ? { ok: true } : rejectedTransition(ctx, id)
}

/**
 * Raw rows of a project that no longer accepts work (disabled or removed) can never be processed,
 * and parked needs-auth rows would otherwise hold queue capacity forever. History stays: the row is
 * finished like a worker skip and keeps its dedupe key. Cost: one DISTINCT scan of open rows per config write.
 */
export function settleForgeUndeliverableWebhookDeliveries(
  ctx: ForgeLedgerContext,
  isActive: (instanceId: string, projectId: string) => boolean
): void {
  const open = ctx.db
    .prepare(
      `SELECT DISTINCT instance_id, project_id FROM webhook_deliveries
       WHERE host_id = ? AND state IN ('pending', 'needs-auth')`
    )
    .all(ctx.hostId)
  for (const row of open) {
    const instanceId = rowText(row, 'instance_id')
    const projectId = rowText(row, 'project_id')
    if (!isActive(instanceId, projectId)) {
      ctx.db
        .prepare(
          `UPDATE webhook_deliveries SET state = 'done', ${FINISH_SQL}
           WHERE host_id = ? AND instance_id = ? AND project_id = ?
             AND state IN ('pending', 'needs-auth')`
        )
        .run(ctx.now(), ctx.hostId, instanceId, projectId)
    }
  }
}

/** Needs-auth rows already count toward capacity, so requeueing cannot overflow the queue. */
export function requeueForgeWebhookNeedsAuth(ctx: ForgeLedgerContext, instanceId: string): number {
  return Number(
    ctx.db
      .prepare(
        `UPDATE webhook_deliveries SET state = 'pending', attempts = 0, next_attempt_at = NULL
         WHERE host_id = ? AND instance_id = ? AND state = 'needs-auth'`
      )
      .run(ctx.hostId, instanceId).changes
  )
}

export type ForgeWebhookWorkSchedule = {
  pending: number
  needsAuth: number
  nextAttemptAtMs: number | null
}

/** Durable view of outstanding work so a restart can re-arm its timer without polling. */
export const FORGE_WEBHOOK_SCHEDULE_SQL = `SELECT
    COALESCE(SUM(state = 'pending'), 0) AS pending,
    COALESCE(SUM(state = 'needs-auth'), 0) AS needs_auth,
    MIN(CASE WHEN state = 'pending' THEN COALESCE(next_attempt_at, admitted_at) END) AS next_at
  FROM webhook_deliveries WHERE host_id = ? AND state IN ('pending', 'needs-auth')`

export function getForgeWebhookWorkSchedule(ctx: ForgeLedgerContext): ForgeWebhookWorkSchedule {
  const row = ctx.db.prepare(FORGE_WEBHOOK_SCHEDULE_SQL).get(ctx.hostId)
  return {
    pending: row ? rowNumber(row, 'pending') : 0,
    needsAuth: row ? rowNumber(row, 'needs_auth') : 0,
    nextAttemptAtMs: row && row.next_at !== null ? rowNumber(row, 'next_at') : null
  }
}

/** The horizon runs from completion so a long-pending delivery keeps its dedupe key after it finishes. */
export function pruneFinishedForgeWebhookDeliveries(
  ctx: ForgeLedgerContext,
  query: { nowMs: number; olderThanMs: number; limit: number }
): number {
  assertSafeNowMs(query.nowMs)
  assertSafeNowMs(query.olderThanMs)
  // Anything but a finite positive limit deletes nothing, never "unlimited".
  const limit = Number.isFinite(query.limit) && query.limit > 0 ? Math.trunc(query.limit) : 0
  return Number(
    ctx.db.prepare(FORGE_WEBHOOK_PRUNE_SQL).run(ctx.hostId, query.nowMs - query.olderThanMs, limit)
      .changes
  )
}
