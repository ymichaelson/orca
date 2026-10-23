import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { rowNumber } from './forge-inbox-rows'
import type { ForgeEventIngest, ForgeIngestResult } from './forge-inbox-types'

function assertIngestable(ctx: ForgeLedgerContext, input: ForgeEventIngest): void {
  if (input.hostId !== ctx.hostId) {
    throw new Error(`forge inbox event for host ${input.hostId} sent to host ${ctx.hostId}`)
  }
  if (!Number.isFinite(input.sourceOrder)) {
    throw new Error('forge inbox event sourceOrder must be a finite number')
  }
}

/** One transaction: delivery dedupe, item and revision upkeep, event, optional queued run. */
export function ingestForgeEvent(
  ctx: ForgeLedgerContext,
  input: ForgeEventIngest
): ForgeIngestResult {
  assertIngestable(ctx, input)
  return runForgeTransaction(ctx.db, () => ingestForgeEventInTransaction(ctx, input))
}

/** For callers that already hold the write transaction; runForgeTransaction is not re-entrant. */
export function ingestForgeEventInTransaction(
  ctx: ForgeLedgerContext,
  input: ForgeEventIngest
): ForgeIngestResult {
  assertIngestable(ctx, input)
  const { db } = ctx
  const seen = db
    .prepare(
      'SELECT event_id FROM deliveries WHERE host_id = ? AND instance_id = ? AND dedupe_key = ?'
    )
    .get(input.hostId, input.instanceId, input.dedupeKey)
  if (seen) {
    return { duplicate: true, eventId: rowNumber(seen, 'event_id') }
  }
  const now = ctx.now()
  const { itemId, revision, newRevision, advanced } = upsertItemRevision(ctx, input)
  const event = db
    .prepare(
      `INSERT INTO events (item_id, revision, event_kind, version_token, source_order,
           payload_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      itemId,
      revision,
      input.eventKind,
      input.versionToken,
      input.sourceOrder,
      JSON.stringify(input.payload ?? null),
      now
    )
  const eventId = rowNumber({ v: event.lastInsertRowid }, 'v')
  db.prepare(
    `INSERT INTO deliveries (host_id, instance_id, dedupe_key, event_id, received_at)
       VALUES (?, ?, ?, ?, ?)`
  ).run(input.hostId, input.instanceId, input.dedupeKey, eventId, now)
  const seq = recordForgeChange(ctx, itemId, 'event', eventId, input.eventKind)
  if (newRevision) {
    staleOutdatedProposals(ctx, itemId)
  }
  // Metadata describes the head: a delayed older delivery only bumps activity.
  db.prepare(
    `UPDATE items SET updated_at = ?, title = COALESCE(?, title),
         state = COALESCE(?, state) WHERE id = ?`
  ).run(
    now,
    advanced ? (input.title ?? null) : null,
    advanced ? (input.itemState ?? null) : null,
    itemId
  )
  const runId = input.queueRun ? queueLatestRun(ctx, itemId, input.queueRun.reason) : null
  return { duplicate: false, eventId, itemId, revision, newRevision, seq, runId }
}

function upsertItemRevision(
  ctx: ForgeLedgerContext,
  input: ForgeEventIngest
): { itemId: number; revision: number; newRevision: boolean; advanced: boolean } {
  const { db } = ctx
  const now = ctx.now()
  const existing = db
    .prepare(
      `SELECT id, current_revision, head_order FROM items
       WHERE host_id = ? AND instance_id = ? AND project_id = ? AND kind = ? AND iid = ?`
    )
    .get(input.hostId, input.instanceId, input.projectId, input.kind, input.iid)
  if (!existing) {
    const created = db
      .prepare(
        `INSERT INTO items (host_id, instance_id, project_id, kind, iid, title, state,
           current_revision, head_order, activity_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`
      )
      .run(
        input.hostId,
        input.instanceId,
        input.projectId,
        input.kind,
        input.iid,
        input.title ?? '',
        input.itemState ?? 'unknown',
        input.sourceOrder,
        now,
        now
      )
    const itemId = rowNumber({ v: created.lastInsertRowid }, 'v')
    insertRevision(ctx, itemId, 1, input.versionToken, input.sourceOrder)
    return { itemId, revision: 1, newRevision: true, advanced: true }
  }
  const itemId = rowNumber(existing, 'id')
  const head = rowNumber(existing, 'current_revision')
  if (input.sourceOrder <= rowNumber(existing, 'head_order')) {
    // Not newer than the watermark: the event is kept, the head stays put.
    return { itemId, revision: head, newRevision: false, advanced: false }
  }
  db.prepare('UPDATE items SET head_order = ? WHERE id = ?').run(input.sourceOrder, itemId)
  const current = db
    .prepare('SELECT version_token FROM item_revisions WHERE item_id = ? AND revision = ?')
    .get(itemId, head)
  if (current?.version_token === input.versionToken) {
    return { itemId, revision: head, newRevision: false, advanced: true }
  }
  const revision = head + 1
  insertRevision(ctx, itemId, revision, input.versionToken, input.sourceOrder)
  db.prepare('UPDATE items SET current_revision = ? WHERE id = ?').run(revision, itemId)
  return { itemId, revision, newRevision: true, advanced: true }
}

function insertRevision(
  ctx: ForgeLedgerContext,
  itemId: number,
  revision: number,
  versionToken: string,
  sourceOrder: number
): void {
  ctx.db
    .prepare(
      `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(itemId, revision, versionToken, sourceOrder, ctx.now())
}

function staleOutdatedProposals(ctx: ForgeLedgerContext, itemId: number): void {
  const outdated = ctx.db
    .prepare(
      `SELECT p.id FROM proposals p JOIN items i ON i.id = p.item_id
       WHERE p.item_id = ? AND p.status = 'pending' AND p.revision < i.current_revision`
    )
    .all(itemId)
  for (const row of outdated) {
    const id = rowNumber(row, 'id')
    ctx.db
      .prepare("UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ?")
      .run(ctx.now(), id)
    recordForgeChange(ctx, itemId, 'proposal', id, 'stale')
  }
}

/** Queued work for another head or older rules would pay for an obsolete snapshot. */
function supersedeQueuedRunsNotForThisHead(
  ctx: ForgeLedgerContext,
  itemId: number,
  policyGeneration: number
): void {
  const stale = ctx.db
    .prepare(
      `SELECT r.id FROM runs r
         JOIN items i ON i.id = r.item_id
         JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
        WHERE r.item_id = ? AND r.state = 'queued'
          AND (r.context_digest <> head.version_token OR r.policy_generation <> ?)`
    )
    .all(itemId, policyGeneration)
  for (const row of stale) {
    const id = rowNumber(row, 'id')
    ctx.db
      .prepare(
        "UPDATE runs SET state = 'superseded', generation = generation + 1, updated_at = ? WHERE id = ?"
      )
      .run(ctx.now(), id)
    recordForgeChange(ctx, itemId, 'run', id, 'superseded')
  }
}

/** Coalesces to the latest revision: an older queued run is superseded, running ones are left alone. */
function queueLatestRun(ctx: ForgeLedgerContext, itemId: number, reason: string): number | null {
  const { db } = ctx
  const now = ctx.now()
  const policyGeneration = policyGenerationOfItem(ctx, itemId)
  supersedeQueuedRunsNotForThisHead(ctx, itemId, policyGeneration)
  // A head already dispatched under these rules is a claim, not a fresh bill: a repeat delivery,
  // or a return to a head analysed earlier, must not start or pay for a second analysis. Only
  // superseded runs are exempt — those never ran, so queuing for them is the first payment.
  const claimed = db
    .prepare(
      `SELECT 1 FROM runs r
         JOIN items i ON i.id = r.item_id
         JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
        WHERE r.item_id = ? AND r.context_digest = head.version_token
          AND r.analysis_kind = i.kind AND r.policy_generation = ?
          AND r.state <> 'superseded'
        LIMIT 1`
    )
    .get(itemId, policyGeneration)
  if (claimed) {
    return null
  }
  // The claim is on the head's own digest, never on a delivery's token that may be older than it.
  const created = db
    .prepare(
      `INSERT INTO runs (item_id, revision, state, generation, policy_generation,
           context_digest, analysis_kind, reason, created_at, updated_at)
       SELECT i.id, i.current_revision, 'queued', 0, ?, r.version_token, i.kind, ?, ?, ?
         FROM items i
         JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
        WHERE i.id = ?`
    )
    .run(policyGeneration, reason, now, now, itemId)
  const runId = rowNumber({ v: created.lastInsertRowid }, 'v')
  recordForgeChange(ctx, itemId, 'run', runId, 'queued')
  return runId
}
