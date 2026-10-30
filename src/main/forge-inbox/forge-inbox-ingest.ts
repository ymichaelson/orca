import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { projectEventPolicyGenerationOfItem } from './forge-inbox-project-event-policy'
import { rowNumber, rowText } from './forge-inbox-rows'
import {
  FORGE_PROVISIONAL_REVISION_PREFIX,
  type ForgeEventIngest,
  type ForgeIngestResult
} from './forge-inbox-types'

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

/** The event this delivery already recorded, if any; dedupe is per host, instance and key. */
export function findForgeIngestEventId(
  ctx: ForgeLedgerContext,
  input: Pick<ForgeEventIngest, 'hostId' | 'instanceId' | 'dedupeKey'>
): number | null {
  const seen = ctx.db
    .prepare(
      'SELECT event_id FROM deliveries WHERE host_id = ? AND instance_id = ? AND dedupe_key = ?'
    )
    .get(input.hostId, input.instanceId, input.dedupeKey)
  return seen ? rowNumber(seen, 'event_id') : null
}

/** For callers that already hold the write transaction; runForgeTransaction is not re-entrant. */
export function ingestForgeEventInTransaction(
  ctx: ForgeLedgerContext,
  input: ForgeEventIngest
): ForgeIngestResult {
  assertIngestable(ctx, input)
  const { db } = ctx
  const seenId = findForgeIngestEventId(ctx, input)
  if (seenId !== null) {
    return { duplicate: true, eventId: seenId }
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
  const runId = input.queueRun ? queueForgeItemRun(ctx, itemId, input.queueRun.reason) : null
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

export type QueueForgeItemRunOutcome =
  | { kind: 'queued'; runId: number }
  | { kind: 'claimed' }
  | { kind: 'provisional-head' }
  // No head row means the item or its current revision is missing, so there is nothing to queue for.
  | { kind: 'no-head' }

/** Coalesces to the latest revision: an older queued run is superseded, running ones are left alone. */
export function queueForgeItemRunOutcome(
  ctx: ForgeLedgerContext,
  itemId: number,
  reason: string,
  scope:
    | { purpose: 'question'; deliveryId: number }
    // The one minimum task a declined preparation owes: a deliberate second turn on the same head.
    | { purpose: 'question-task'; deliveryId: number }
    | { purpose: 'answered'; questionId: number }
    | null = null
): QueueForgeItemRunOutcome {
  const { db } = ctx
  const now = ctx.now()
  const head = db
    .prepare(
      `SELECT r.version_token AS token FROM items i
         JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
        WHERE i.id = ? AND i.host_id = ?`
    )
    .get(itemId, ctx.hostId)
  if (!head) {
    return { kind: 'no-head' }
  }
  // A webhook-reported head is provisional: paying for it would analyse a snapshot nobody read back.
  if (rowText(head, 'token').startsWith(FORGE_PROVISIONAL_REVISION_PREFIX)) {
    return { kind: 'provisional-head' }
  }
  // Binding items follow the project event policy; only the retired flow still reads the old table.
  const policyGeneration =
    projectEventPolicyGenerationOfItem(ctx, itemId) ?? policyGenerationOfItem(ctx, itemId)
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
          AND CASE ?
            WHEN 'question' THEN EXISTS (
              SELECT 1 FROM project_event_decisions d
              WHERE d.run_id = r.id AND d.action = 'ask_user' AND d.delivery_id = ?)
            -- Already paid for by the decision's own claim, so the owed task is not a duplicate.
            WHEN 'question-task' THEN 0
            WHEN 'answered' THEN r.origin_question_id = ?
            ELSE NOT EXISTS (
              SELECT 1 FROM project_event_decisions d WHERE d.run_id = r.id AND d.action = 'ask_user')
          END
        LIMIT 1`
    )
    .get(
      itemId,
      policyGeneration,
      scope?.purpose ?? 'ordinary',
      scope?.purpose === 'question' ? scope.deliveryId : null,
      scope?.purpose === 'answered' ? scope.questionId : null
    )
  if (claimed) {
    return { kind: 'claimed' }
  }
  // The claim is on the head's own digest, never on a delivery's token that may be older than it.
  const created = db
    .prepare(
      `INSERT INTO runs (item_id, revision, state, generation, policy_generation,
           context_digest, analysis_kind, reason, created_at, updated_at, origin_question_id)
       SELECT i.id, i.current_revision, 'queued', 0, ?, r.version_token, i.kind, ?, ?, ?, ?
         FROM items i
         JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
        WHERE i.id = ?`
    )
    .run(
      policyGeneration,
      reason,
      now,
      now,
      scope?.purpose === 'answered' ? scope.questionId : null,
      itemId
    )
  const runId = rowNumber({ v: created.lastInsertRowid }, 'v')
  recordForgeChange(ctx, itemId, 'run', runId, 'queued')
  return { kind: 'queued', runId }
}

/** Callers that only need the new run keep the flat shape; dispatch reads the outcome to explain a null. */
export function queueForgeItemRun(
  ctx: ForgeLedgerContext,
  itemId: number,
  reason: string
): number | null {
  const outcome = queueForgeItemRunOutcome(ctx, itemId, reason)
  return outcome.kind === 'queued' ? outcome.runId : null
}
