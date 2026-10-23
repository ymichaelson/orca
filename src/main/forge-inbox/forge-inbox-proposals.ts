import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { readForgeRun } from './forge-inbox-runs'
import { proposalFromRow, receiptFromRow, rowNumber } from './forge-inbox-rows'
import { policyGenerationOfItem, POLICY_GENERATION_OF_ITEM_SQL } from './forge-inbox-policy'
import type { ForgeProposal, ForgeReceipt } from './forge-inbox-types'

export type ForgeProposalCreateResult =
  | { ok: true; proposal: ForgeProposal }
  | { ok: false; reason: 'run-not-running' | 'generation-mismatch' | 'policy-generation-mismatch' }

export type ForgeProposalResolveResult =
  | { ok: true; proposal: ForgeProposal }
  | { ok: false; reason: 'not-found' | 'not-pending' | 'stale' }

export function readForgeProposal(ctx: ForgeLedgerContext, id: number): ForgeProposal | null {
  const row = ctx.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)
  return row ? proposalFromRow(row) : null
}

/**
 * A proposal for an outdated revision is stored stale. Approval state never drives run state.
 * `supersedePending` makes this the item's only live proposal: a newer draft replaces older ones.
 */
export function createForgeProposal(
  ctx: ForgeLedgerContext,
  input: {
    runId: number
    expectedGeneration: number
    body: unknown
    supersedePending?: boolean
  }
): ForgeProposalCreateResult {
  return runForgeTransaction(ctx.db, () => {
    const run = readForgeRun(ctx, input.runId)
    if (!run || run.state !== 'running') {
      return { ok: false, reason: 'run-not-running' }
    }
    if (run.generation !== input.expectedGeneration) {
      return { ok: false, reason: 'generation-mismatch' }
    }
    // Running work keeps its old rules; a revoked run must not bind its draft to the newer policy.
    if (run.policyGeneration !== policyGenerationOfItem(ctx, run.itemId)) {
      return { ok: false, reason: 'policy-generation-mismatch' }
    }
    const current = ctx.db
      .prepare('SELECT current_revision FROM items WHERE id = ?')
      .get(run.itemId)
    const isCurrent =
      current !== undefined && rowNumber(current, 'current_revision') === run.revision
    const now = ctx.now()
    const inserted = ctx.db
      .prepare(
        `INSERT INTO proposals (run_id, item_id, revision, policy_generation, status, body_json,
           created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.itemId,
        run.revision,
        run.policyGeneration,
        isCurrent ? 'pending' : 'stale',
        JSON.stringify(input.body ?? null),
        now,
        isCurrent ? null : now
      )
    const id = rowNumber({ v: inserted.lastInsertRowid }, 'v')
    recordForgeChange(ctx, run.itemId, 'proposal', id, isCurrent ? 'pending' : 'stale')
    if (isCurrent && input.supersedePending) {
      const older = ctx.db
        .prepare("SELECT id FROM proposals WHERE item_id = ? AND status = 'pending' AND id <> ?")
        .all(run.itemId, id)
      for (const row of older) {
        const olderId = rowNumber(row, 'id')
        ctx.db
          .prepare(
            "UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ? AND status = 'pending'"
          )
          .run(now, olderId)
        recordForgeChange(ctx, run.itemId, 'proposal', olderId, 'stale')
      }
    }
    const proposal = readForgeProposal(ctx, id)
    if (!proposal) {
      throw new Error('forge inbox proposal vanished inside its create transaction')
    }
    return { ok: true, proposal }
  })
}

/** Exact-revision CAS against the item head: of concurrent approvals exactly one consumes. */
export function consumeForgeProposal(
  ctx: ForgeLedgerContext,
  id: number,
  expected: { revision: number; policyGeneration: number }
): ForgeProposalResolveResult {
  return runForgeTransaction(ctx.db, () => {
    const claimed = ctx.db
      .prepare(
        `UPDATE proposals SET status = 'consumed', resolved_at = ?
         WHERE id = ? AND status = 'pending' AND revision = ? AND policy_generation = ?
           AND policy_generation = (${POLICY_GENERATION_OF_ITEM_SQL})
           AND revision = (SELECT current_revision FROM items WHERE id = proposals.item_id)`
      )
      .run(ctx.now(), id, expected.revision, expected.policyGeneration)
    const proposal = readForgeProposal(ctx, id)
    if (!proposal) {
      return { ok: false, reason: 'not-found' }
    }
    if (claimed.changes !== 1) {
      return { ok: false, reason: proposal.status === 'pending' ? 'stale' : 'not-pending' }
    }
    recordForgeChange(ctx, proposal.itemId, 'proposal', id, 'consumed')
    return { ok: true, proposal }
  })
}

export function rejectForgeProposal(
  ctx: ForgeLedgerContext,
  id: number
): ForgeProposalResolveResult {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare(
        "UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(ctx.now(), id)
    const proposal = readForgeProposal(ctx, id)
    if (!proposal) {
      return { ok: false, reason: 'not-found' }
    }
    if (result.changes !== 1) {
      return { ok: false, reason: 'not-pending' }
    }
    recordForgeChange(ctx, proposal.itemId, 'proposal', id, 'rejected')
    return { ok: true, proposal }
  })
}

/** The thing the draft was written against changed: record it as stale rather than silently live. */
export function staleForgeProposal(
  ctx: ForgeLedgerContext,
  id: number,
  expected: { revision: number; policyGeneration: number }
): ForgeProposalResolveResult {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare(
        `UPDATE proposals SET status = 'stale', resolved_at = ?
         WHERE id = ? AND status = 'pending' AND revision = ? AND policy_generation = ?`
      )
      .run(ctx.now(), id, expected.revision, expected.policyGeneration)
    const proposal = readForgeProposal(ctx, id)
    if (!proposal) {
      return { ok: false, reason: 'not-found' }
    }
    if (result.changes !== 1) {
      return { ok: false, reason: proposal.status === 'pending' ? 'stale' : 'not-pending' }
    }
    recordForgeChange(ctx, proposal.itemId, 'proposal', id, 'stale')
    return { ok: true, proposal }
  })
}

export type ForgeReceiptBegin =
  | { started: true; receipt: ForgeReceipt }
  | { started: false; receipt: ForgeReceipt }
  | { started: false; receipt: null }

/**
 * One receipt per approved proposal, durable BEFORE the forge write: an existing row means the
 * write may already have landed, so the caller reconciles instead of replaying. The forge-side
 * idempotency key is derived from the proposal and is never caller-chosen.
 */
/** A first write needs the approved revision and policy generation to still be current. */
function isStillAuthorised(ctx: ForgeLedgerContext, proposal: ForgeProposal): boolean {
  const row = ctx.db
    .prepare(
      `SELECT 1 AS ok FROM proposals
       WHERE id = ? AND revision = (SELECT current_revision FROM items WHERE id = proposals.item_id)
         AND policy_generation = (${POLICY_GENERATION_OF_ITEM_SQL})`
    )
    .get(proposal.id)
  return row !== undefined
}

export function beginForgeReceipt(
  ctx: ForgeLedgerContext,
  input: { proposalId: number }
): ForgeReceiptBegin {
  return runForgeTransaction(ctx.db, () => {
    const existing = ctx.db
      .prepare('SELECT * FROM receipts WHERE proposal_id = ?')
      .get(input.proposalId)
    if (existing) {
      return { started: false, receipt: receiptFromRow(existing) }
    }
    const proposal = readForgeProposal(ctx, input.proposalId)
    if (!proposal || proposal.status !== 'consumed' || !isStillAuthorised(ctx, proposal)) {
      return { started: false, receipt: null }
    }
    const now = ctx.now()
    const inserted = ctx.db
      .prepare(
        `INSERT INTO receipts (proposal_id, idempotency_key, state, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`
      )
      .run(input.proposalId, `orca-proposal-${input.proposalId}`, now, now)
    const id = rowNumber({ v: inserted.lastInsertRowid }, 'v')
    recordForgeChange(ctx, proposal.itemId, 'receipt', id, 'pending')
    return { started: true, receipt: readReceipt(ctx, id) }
  })
}

export function finishForgeReceipt(
  ctx: ForgeLedgerContext,
  id: number,
  outcome: { state: 'applied' | 'failed' | 'unknown'; result?: unknown }
): ForgeReceipt | null {
  return runForgeTransaction(ctx.db, () => {
    const updated = ctx.db
      .prepare(
        `UPDATE receipts SET state = ?, result_json = ?, updated_at = ?
         WHERE id = ? AND state IN ('pending', 'unknown')`
      )
      .run(outcome.state, JSON.stringify(outcome.result ?? null), ctx.now(), id)
    if (updated.changes !== 1) {
      return null
    }
    const receipt = readReceipt(ctx, id)
    const proposal = readForgeProposal(ctx, receipt.proposalId)
    if (proposal) {
      recordForgeChange(ctx, proposal.itemId, 'receipt', id, outcome.state)
    }
    return receipt
  })
}

/** After a restart a pending receipt's write outcome is unknown; never retried blindly. */
export function markInterruptedForgeReceiptsUnknown(ctx: ForgeLedgerContext): number {
  return runForgeTransaction(ctx.db, () => {
    const pending = ctx.db
      .prepare(
        `SELECT r.id, p.item_id FROM receipts r JOIN proposals p ON p.id = r.proposal_id
         WHERE r.state = 'pending'`
      )
      .all()
    for (const row of pending) {
      const id = rowNumber(row, 'id')
      ctx.db
        .prepare("UPDATE receipts SET state = 'unknown', updated_at = ? WHERE id = ?")
        .run(ctx.now(), id)
      recordForgeChange(ctx, rowNumber(row, 'item_id'), 'receipt', id, 'unknown')
    }
    return pending.length
  })
}

function readReceipt(ctx: ForgeLedgerContext, id: number): ForgeReceipt {
  const row = ctx.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id)
  if (!row) {
    throw new Error('forge inbox receipt vanished inside its transaction')
  }
  return receiptFromRow(row)
}
