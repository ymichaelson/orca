import type { ForgeLedgerContext } from './forge-inbox-context'
import { readOutcomes, type Reads } from './forge-inbox-dispatch-claim-observation'
import {
  beginDispatchConfirmationAttempt,
  finishDispatchConfirmation,
  listDueDispatchConfirmations,
  readDispatchConfirmationWork,
  recordDispatchConfirmationProgress,
  revertDispatchConfirmationAttempt,
  type DispatchConfirmationState,
  type DispatchConfirmationWork
} from './forge-inbox-dispatch-confirmation'
import type {
  DispatchConfirmationReader,
  DispatchConfirmationReaderFactory
} from './forge-inbox-dispatch-confirmation-reader'
import {
  preReadOutcome,
  readFailed,
  rollUpClaims,
  scanForStrayComments,
  type ClaimOutcome,
  type ConfirmationItem,
  type ConfirmationRollUp
} from './forge-inbox-dispatch-confirmation-verdict'
import { readStoredDispatchReport, type DispatchClaim } from './forge-inbox-dispatch-report'
import { forgeErrorLabel } from './forge-inbox-error-label'
import { rowNumber, rowText } from './forge-inbox-rows'

export { getDispatchConfirmationSchedule } from './forge-inbox-dispatch-confirmation'

export type DispatchConfirmationDeps = { createReader: DispatchConfirmationReaderFactory }

const MAX_ATTEMPTS = 4
const DEADLINE_MS = 10 * 60_000
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]
const ROWS_PER_DRAIN = 20

type Finish = Exclude<DispatchConfirmationState, 'unconfirmed'>
type Evidence = { code: string | null; claims: ClaimOutcome[] }

function evidenceJson(attempts: number, checkedAt: number, evidence: Evidence): string {
  return JSON.stringify({
    attempts,
    checkedAt,
    ...(evidence.code === null ? {} : { code: evidence.code }),
    claims: evidence.claims
  })
}

function finish(
  ctx: ForgeLedgerContext,
  work: DispatchConfirmationWork,
  state: Finish,
  attempts: number,
  evidence: Evidence
): void {
  finishDispatchConfirmation(ctx, work, {
    state,
    evidenceJson: evidenceJson(attempts, ctx.now(), evidence)
  })
}

function readBinding(
  ctx: ForgeLedgerContext,
  work: DispatchConfirmationWork
): { gitlabHost: string; repoPath: string; gitlabProjectId: number } | null {
  const row = ctx.db
    .prepare(
      'SELECT project_path, gitlab_host, gitlab_project_id FROM project_bindings WHERE binding_id = ?'
    )
    .get(work.bindingId)
  if (
    !row ||
    rowText(row, 'gitlab_host') !== work.gitlabHost ||
    rowNumber(row, 'gitlab_project_id') !== work.gitlabProjectId
  ) {
    return null
  }
  return {
    gitlabHost: work.gitlabHost,
    repoPath: rowText(row, 'project_path'),
    gitlabProjectId: work.gitlabProjectId
  }
}

type Prepared =
  | { kind: 'settled'; state: Finish; evidence: Evidence }
  | { kind: 'check'; claims: DispatchClaim[]; mode: ReportMode; binding: BoundProject }

type ReportMode = 'read-only' | 'remote-actions' | 'unknown'
type BoundProject = NonNullable<ReturnType<typeof readBinding>>

const settled = (state: Finish, code: string): Prepared => ({
  kind: 'settled',
  state,
  evidence: { code, claims: [] }
})

/** Verdicts that need no GitLab read: the report itself, or the binding, rules the claim out. */
function prepare(ctx: ForgeLedgerContext, work: DispatchConfirmationWork): Prepared {
  const report = readStoredDispatchReport(work.reportJson)
  if (report.status === 'report-missing') {
    return settled('unconfirmable', 'report-missing')
  }
  if (report.status === 'ambiguous') {
    return settled('unconfirmable', 'report-ambiguous')
  }
  if (report.claims.length === 0) {
    if (report.mode !== 'read-only') {
      return settled(
        'unconfirmable',
        report.mode === 'unknown' ? 'mode-unknown' : 'no-claims-reported'
      )
    }
    // Only an issue or merge request has notes to list, so only there can "nothing done" be checked.
    if (work.itemKind !== 'issue' && work.itemKind !== 'merge_request') {
      return settled('unconfirmable', 'read-only-unchecked')
    }
  }
  const binding = readBinding(ctx, work)
  return binding === null
    ? settled('unconfirmable', 'binding-changed')
    : { kind: 'check', claims: report.claims, mode: report.mode, binding }
}

type ReadOnlyScan = 'pending' | 'found' | 'clean' | 'incomplete'

async function scanOwnNotes(
  reader: DispatchConfirmationReader,
  item: ConfirmationItem,
  marker: string
): Promise<ReadOnlyScan> {
  const user = await reader.getCurrentUser()
  if (!user.ok) {
    return 'pending'
  }
  const notes =
    item.itemKind === 'issue'
      ? await reader.listIssueNotes(item.itemIid)
      : await reader.listMergeRequestNotes(item.itemIid)
  return notes.ok
    ? scanForStrayComments(
        { data: notes.data, complete: notes.complete },
        marker,
        user.data.username
      )
    : 'pending'
}

/** An agent unsure of what it did can never read as confirmed, only as unconfirmable. */
function capByMode(rolled: ConfirmationRollUp, mode: ReportMode): ConfirmationRollUp {
  return rolled.kind === 'final' && rolled.state === 'confirmed' && mode === 'unknown'
    ? { kind: 'final', state: 'unconfirmable', code: 'mode-unknown' }
    : rolled
}

async function reconcileOne(
  ctx: ForgeLedgerContext,
  deps: DispatchConfirmationDeps,
  work: DispatchConfirmationWork,
  signal: AbortSignal | undefined
): Promise<void> {
  const prepared = prepare(ctx, work)
  if (prepared.kind === 'settled') {
    finish(ctx, work, prepared.state, work.attempts, prepared.evidence)
    return
  }
  const { claims, mode, binding } = prepared
  const item: ConfirmationItem = {
    itemKind: work.itemKind,
    itemIid: work.itemIid,
    gitlabProjectId: work.gitlabProjectId,
    expectedSha: work.expectedSha
  }
  const outcomes = new Map<number, ClaimOutcome>()
  const pending: Reads[] = []
  claims.forEach((claim, index) => {
    const decided = preReadOutcome(item, claim)
    if (decided) {
      outcomes.set(index, decided)
    } else {
      pending.push({ claim, index })
    }
  })
  const ordered = () => claims.flatMap((_, index) => outcomes.get(index) ?? [])
  // With no claims left to read, a read-only report is checked for comments it never mentioned.
  const scanning = claims.length === 0
  if (pending.length === 0 && !scanning) {
    const rolled = capByMode(rollUpClaims(ordered()), mode)
    if (rolled.kind === 'final') {
      finish(ctx, work, rolled.state, work.attempts, { code: rolled.code, claims: ordered() })
    }
    return
  }
  const now = ctx.now()
  const attempts = work.attempts + 1
  const deadlineAt = work.deadlineAt ?? now + DEADLINE_MS
  beginDispatchConfirmationAttempt(ctx, work.runId, {
    nextAttemptAt: now + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 0),
    deadlineAt: now + DEADLINE_MS
  })
  let scan: ReadOnlyScan = 'pending'
  try {
    const reader = deps.createReader(binding, signal)
    if (scanning) {
      scan = await scanOwnNotes(reader, item, work.marker)
    } else {
      const read = await readOutcomes(reader, item, work.marker, pending)
      read.forEach((outcome, index) => outcomes.set(index, outcome))
    }
  } catch {
    pending.forEach(({ claim, index }) => outcomes.set(index, readFailed(claim)))
  }
  if (signal?.aborted) {
    revertDispatchConfirmationAttempt(ctx, work)
    return
  }
  const rolled = scanning ? rollUpScan(scan) : capByMode(rollUpClaims(ordered()), mode)
  if (rolled.kind === 'final') {
    finish(ctx, work, rolled.state, attempts, { code: rolled.code, claims: ordered() })
    return
  }
  // The last read of a late row still counts: a restart gets a fresh look before any deadline verdict.
  if (attempts >= MAX_ATTEMPTS || ctx.now() >= deadlineAt) {
    finish(ctx, work, 'unconfirmable', attempts, {
      code: attempts >= MAX_ATTEMPTS ? 'unproven' : 'deadline',
      claims: ordered()
    })
    return
  }
  recordDispatchConfirmationProgress(
    ctx,
    work.runId,
    evidenceJson(attempts, ctx.now(), { code: null, claims: ordered() })
  )
}

function rollUpScan(scan: ReadOnlyScan): ConfirmationRollUp {
  switch (scan) {
    case 'found':
      return { kind: 'final', state: 'contradicted', code: 'unreported-comment' }
    case 'incomplete':
      return { kind: 'final', state: 'unconfirmable', code: 'read-only-unchecked' }
    case 'clean':
      return { kind: 'final', state: 'no-claim', code: 'read-only-report' }
    case 'pending':
      return { kind: 'pending' }
  }
}

/**
 * One bad row must not starve the rest: its failure is counted and its next attempt always moves
 * forward first, so even a verdict that cannot be written leaves the row out of the due window.
 */
function recordRowFailure(ctx: ForgeLedgerContext, work: DispatchConfirmationWork): void {
  const fresh = readDispatchConfirmationWork(ctx, work.runId)
  if (fresh === null) {
    return
  }
  const now = ctx.now()
  const counted = fresh.attempts > work.attempts
  const attempts = counted ? fresh.attempts : fresh.attempts + 1
  const nextAttemptAt = now + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 0)
  if (counted) {
    ctx.db
      .prepare(
        `UPDATE run_dispatch_confirmations SET next_attempt_at = ?, updated_at = ?
         WHERE run_id = ? AND host_id = ? AND state = 'unconfirmed'`
      )
      .run(nextAttemptAt, now, work.runId, ctx.hostId)
  } else {
    beginDispatchConfirmationAttempt(ctx, work.runId, {
      nextAttemptAt,
      deadlineAt: now + DEADLINE_MS
    })
  }
  if (attempts >= MAX_ATTEMPTS) {
    finish(ctx, fresh, 'unconfirmable', attempts, { code: 'unproven', claims: [] })
  }
}

/**
 * Checks what dispatched agents say they did on GitLab. Reads only: no launcher or write
 * capability exists here, so a restart can resume the checks but never repeat the work.
 */
export async function reconcileDispatchConfirmations(
  ctx: ForgeLedgerContext,
  deps: DispatchConfirmationDeps,
  signal?: AbortSignal
): Promise<{ checked: number; capped: boolean }> {
  const due = listDueDispatchConfirmations(ctx, ROWS_PER_DRAIN)
  let checked = 0
  for (const work of due) {
    if (signal?.aborted) {
      break
    }
    try {
      await reconcileOne(ctx, deps, work, signal)
    } catch (error) {
      console.warn('[forge-inbox] checking a dispatch failed', forgeErrorLabel(error))
      try {
        recordRowFailure(ctx, work)
      } catch {
        // A row that cannot even record its failure stays due; the other rows still run.
      }
    }
    checked += 1
  }
  return { checked, capped: due.length === ROWS_PER_DRAIN && !signal?.aborted }
}
