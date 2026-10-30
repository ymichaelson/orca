import { randomBytes } from 'node:crypto'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import { rowNumber, rowText } from './forge-inbox-rows'

const DISPATCH_CONFIRMATION_STATES = [
  'unconfirmed',
  'confirmed',
  'contradicted',
  'unconfirmable',
  'no-claim'
] as const

export type DispatchConfirmationState = (typeof DISPATCH_CONFIRMATION_STATES)[number]

export type DispatchConfirmationInput = {
  runId: number
  bindingId: string
  gitlabHost: string
  gitlabProjectId: number
  itemKind: string
  itemIid: number
  expectedSha: string | null
}

export type DispatchConfirmation = DispatchConfirmationInput & {
  state: DispatchConfirmationState
  marker: string
}

/** Records a dispatch as unconfirmed and returns the marker its comments must carry. */
export function createDispatchConfirmation(
  ctx: ForgeLedgerContext,
  input: DispatchConfirmationInput
): string {
  const marker = `<!-- orca-run:${input.runId}:${randomBytes(16).toString('hex')} -->`
  const now = ctx.now()
  ctx.db
    .prepare(
      `INSERT INTO run_dispatch_confirmations (run_id, host_id, state, binding_id, gitlab_host,
         gitlab_project_id, item_kind, item_iid, expected_sha, marker, created_at, updated_at)
       VALUES (?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId,
      ctx.hostId,
      input.bindingId,
      input.gitlabHost,
      input.gitlabProjectId,
      input.itemKind,
      input.itemIid,
      input.expectedSha,
      marker,
      now,
      now
    )
  return marker
}

export function readDispatchConfirmation(
  ctx: ForgeLedgerContext,
  runId: number
): DispatchConfirmation | null {
  const row = ctx.db
    .prepare('SELECT * FROM run_dispatch_confirmations WHERE run_id = ? AND host_id = ?')
    .get(runId, ctx.hostId)
  const state = DISPATCH_CONFIRMATION_STATES.find((known) => known === row?.state)
  if (!row || !state) {
    return null
  }
  return {
    runId: rowNumber(row, 'run_id'),
    state,
    bindingId: rowText(row, 'binding_id'),
    gitlabHost: rowText(row, 'gitlab_host'),
    gitlabProjectId: rowNumber(row, 'gitlab_project_id'),
    itemKind: rowText(row, 'item_kind'),
    itemIid: rowNumber(row, 'item_iid'),
    expectedSha: typeof row.expected_sha === 'string' ? row.expected_sha : null,
    marker: rowText(row, 'marker')
  }
}

/** The agent never received the prompt, so there is nothing on GitLab to confirm. */
export function settleDispatchConfirmationNoClaim(ctx: ForgeLedgerContext, runId: number): void {
  ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations SET state = 'no-claim', updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
    )
    .run(ctx.now(), runId, ctx.hostId)
}

export type DispatchCapture = {
  sessionId: string
  clientMessageId: string
  turnId: string
  report: DispatchReportCapture
}

/** Keeps what the turn reported; the first capture wins and the verdict stays unconfirmed. */
export function recordDispatchCapture(
  ctx: ForgeLedgerContext,
  runId: number,
  capture: DispatchCapture
): boolean {
  const updated = ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations
       SET session_id = ?, client_message_id = ?, turn_id = ?, report_json = ?, updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed' AND report_json IS NULL`
    )
    .run(
      capture.sessionId,
      capture.clientMessageId,
      capture.turnId,
      JSON.stringify(capture.report),
      ctx.now(),
      runId,
      ctx.hostId
    )
  return updated.changes === 1
}

export type DispatchConfirmationWork = DispatchConfirmation & {
  itemId: number
  reportJson: string | null
  attempts: number
  nextAttemptAt: number | null
  deadlineAt: number | null
}

/** The change label a verdict records, which notification candidates read back. */
export const DISPATCH_CHANGE_PREFIX = 'dispatch-'

const SETTLED_RUN_SQL = `r.state IN ('succeeded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM project_event_decisions d
    WHERE d.run_id = r.id AND d.action = 'ask_user')`

/** Unconfirmed rows whose run has ended and whose next attempt is due. */
export function listDueDispatchConfirmations(
  ctx: ForgeLedgerContext,
  limit: number
): DispatchConfirmationWork[] {
  return ctx.db
    .prepare(
      `SELECT c.run_id FROM run_dispatch_confirmations c JOIN runs r ON r.id = c.run_id
       WHERE c.host_id = ? AND c.state = 'unconfirmed' AND ${SETTLED_RUN_SQL}
         AND COALESCE(c.next_attempt_at, 0) <= ?
       ORDER BY c.run_id LIMIT ?`
    )
    .all(ctx.hostId, ctx.now(), limit)
    .flatMap((row) => {
      const work = readDispatchConfirmationWork(ctx, rowNumber(row, 'run_id'))
      return work ? [work] : []
    })
}

export function readDispatchConfirmationWork(
  ctx: ForgeLedgerContext,
  runId: number
): DispatchConfirmationWork | null {
  const confirmation = readDispatchConfirmation(ctx, runId)
  const row = ctx.db
    .prepare(
      `SELECT r.item_id, c.report_json, c.attempts, c.next_attempt_at, c.deadline_at
       FROM run_dispatch_confirmations c JOIN runs r ON r.id = c.run_id WHERE c.run_id = ?`
    )
    .get(runId)
  if (!confirmation || !row) {
    return null
  }
  return {
    ...confirmation,
    itemId: rowNumber(row, 'item_id'),
    reportJson: typeof row.report_json === 'string' ? row.report_json : null,
    attempts: rowNumber(row, 'attempts'),
    nextAttemptAt: typeof row.next_attempt_at === 'number' ? row.next_attempt_at : null,
    deadlineAt: typeof row.deadline_at === 'number' ? row.deadline_at : null
  }
}

export function getDispatchConfirmationSchedule(ctx: ForgeLedgerContext): {
  pending: number
  nextAttemptAtMs: number | null
} {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS pending, MIN(COALESCE(c.next_attempt_at, 0)) AS next_at
       FROM run_dispatch_confirmations c JOIN runs r ON r.id = c.run_id
       WHERE c.host_id = ? AND c.state = 'unconfirmed' AND ${SETTLED_RUN_SQL}`
    )
    .get(ctx.hostId)
  return {
    pending: row ? rowNumber(row, 'pending') : 0,
    nextAttemptAtMs: row && typeof row.next_at === 'number' ? row.next_at : null
  }
}

/** Written before the read it pays for, so a crash mid-read still spends the attempt. */
export function beginDispatchConfirmationAttempt(
  ctx: ForgeLedgerContext,
  runId: number,
  plan: { nextAttemptAt: number; deadlineAt: number }
): void {
  ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations
       SET attempts = attempts + 1, next_attempt_at = ?, deadline_at = COALESCE(deadline_at, ?),
         updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
    )
    .run(plan.nextAttemptAt, plan.deadlineAt, ctx.now(), runId, ctx.hostId)
}

/** A read that shutdown cut short proved nothing, so the attempt it paid for is handed back. */
export function revertDispatchConfirmationAttempt(
  ctx: ForgeLedgerContext,
  work: Pick<DispatchConfirmationWork, 'runId' | 'attempts' | 'nextAttemptAt' | 'deadlineAt'>
): void {
  ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations
       SET attempts = ?, next_attempt_at = ?, deadline_at = ?, updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
    )
    .run(work.attempts, work.nextAttemptAt, work.deadlineAt, ctx.now(), work.runId, ctx.hostId)
}

export function recordDispatchConfirmationProgress(
  ctx: ForgeLedgerContext,
  runId: number,
  evidenceJson: string
): void {
  ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations SET evidence_json = ?, updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
    )
    .run(evidenceJson, ctx.now(), runId, ctx.hostId)
}

/** The one-way step out of unconfirmed; clients are told so the item re-reads its handling. */
export function finishDispatchConfirmation(
  ctx: ForgeLedgerContext,
  work: Pick<DispatchConfirmationWork, 'runId' | 'itemId'>,
  verdict: { state: Exclude<DispatchConfirmationState, 'unconfirmed'>; evidenceJson: string }
): boolean {
  return runForgeTransaction(ctx.db, () =>
    finishDispatchConfirmationInTransaction(ctx, work, verdict)
  )
}

/** For a caller whose own transaction must commit the verdict together with what justified it. */
export function finishDispatchConfirmationInTransaction(
  ctx: ForgeLedgerContext,
  work: Pick<DispatchConfirmationWork, 'runId' | 'itemId'>,
  verdict: { state: Exclude<DispatchConfirmationState, 'unconfirmed'>; evidenceJson: string }
): boolean {
  const updated = ctx.db
    .prepare(
      `UPDATE run_dispatch_confirmations
       SET state = ?, evidence_json = ?, next_attempt_at = NULL, updated_at = ?
       WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
    )
    .run(verdict.state, verdict.evidenceJson, ctx.now(), work.runId, ctx.hostId)
  if (updated.changes !== 1) {
    return false
  }
  recordForgeChange(
    ctx,
    work.itemId,
    'run',
    work.runId,
    `${DISPATCH_CHANGE_PREFIX}${verdict.state}`
  )
  return true
}
