import { forgeCommitSignal } from './forge-inbox-commit-signal'
import { runForgeTransaction } from './forge-inbox-database'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  changeFromRow,
  itemFromRow,
  proposalFromRow,
  rowNumber,
  runFromRow
} from './forge-inbox-rows'
import type {
  ForgeChange,
  ForgeItem,
  ForgePage,
  ForgeProposal,
  ForgeRevision,
  ForgeRun,
  ForgeRunState,
  ForgeInstanceScope
} from './forge-inbox-types'

export const FORGE_PAGE_MAX = 100
const FORGE_PAGE_DEFAULT = 50

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return FORGE_PAGE_DEFAULT
  }
  return Math.min(Math.max(Math.floor(limit), 1), FORGE_PAGE_MAX)
}

/**
 * Ordered by immutable item id (newest created first) so later activity can never skip or repeat
 * a row between pages; `activitySeq` and the changes feed carry recency. `cursor` is the last id seen.
 */
export function listForgeItems(
  ctx: ForgeLedgerContext,
  query: ForgeInstanceScope & {
    clientId: string
    unreadOnly?: boolean
    limit?: number
    cursor?: number
  }
): ForgePage<ForgeItem> {
  const size = pageSize(query.limit)
  const rows = ctx.db
    .prepare(
      `SELECT i.*, r.read_seq AS read_seq FROM items i
       LEFT JOIN item_reads r ON r.item_id = i.id AND r.client_id = ?
       WHERE i.host_id = ? AND (? IS NULL OR i.instance_id = ?)
         AND (? IS NULL OR i.id < ?)
         AND (? = 0 OR r.read_seq IS NULL OR r.read_seq < i.activity_seq)
       ORDER BY i.id DESC LIMIT ?`
    )
    .all(
      query.clientId,
      ctx.hostId,
      query.instanceId ?? null,
      query.instanceId ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      query.unreadOnly ? 1 : 0,
      size + 1
    )
  const items = rows
    .slice(0, size)
    .map((row) => itemFromRow(row, row.read_seq === null ? null : rowNumber(row, 'read_seq')))
  return {
    rows: items,
    nextCursor: rows.length > size ? (items.at(-1)?.id ?? null) : null
  }
}

/** No client cursor, so `unread` is not meaningful on this read. */
export function readForgeItem(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  itemId: number
): ForgeItem | null {
  const row = ctx.db
    .prepare('SELECT * FROM items WHERE id = ? AND host_id = ? AND (? IS NULL OR instance_id = ?)')
    .get(itemId, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
  return row ? itemFromRow(row, null) : null
}

export type ForgeItemDetail = {
  item: ForgeItem
  revisions: ForgeRevision[]
  runs: ForgeRun[]
  proposals: ForgeProposal[]
}

export function getForgeItemDetail(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  itemId: number,
  clientId: string
): ForgeItemDetail | null {
  const row = ctx.db
    .prepare(
      `SELECT i.*, r.read_seq AS read_seq FROM items i
       LEFT JOIN item_reads r ON r.item_id = i.id AND r.client_id = ?
       WHERE i.id = ? AND i.host_id = ? AND (? IS NULL OR i.instance_id = ?)`
    )
    .get(clientId, itemId, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
  if (!row) {
    return null
  }
  const revisions = ctx.db
    .prepare('SELECT * FROM item_revisions WHERE item_id = ? ORDER BY revision DESC LIMIT ?')
    .all(itemId, FORGE_PAGE_MAX)
    .map((r) => ({
      id: rowNumber(r, 'id'),
      itemId,
      revision: rowNumber(r, 'revision'),
      versionToken: String(r.version_token),
      createdAt: rowNumber(r, 'created_at')
    }))
  const proposals = ctx.db
    .prepare('SELECT * FROM proposals WHERE item_id = ? ORDER BY id DESC LIMIT ?')
    .all(itemId, FORGE_PAGE_MAX)
    .map(proposalFromRow)
  return {
    item: itemFromRow(row, row.read_seq === null ? null : rowNumber(row, 'read_seq')),
    revisions,
    runs: listForgeRuns(ctx, scope, { itemId, limit: FORGE_PAGE_MAX }).rows,
    proposals
  }
}

/** Newest first; `cursor` is the id of the last run already seen. */
export function listForgeRuns(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  query: { itemId?: number; states?: ForgeRunState[]; limit?: number; cursor?: number }
): ForgePage<ForgeRun> {
  const size = pageSize(query.limit)
  const states = query.states ?? []
  const rows = ctx.db
    .prepare(
      `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.host_id = ? AND (? IS NULL OR i.instance_id = ?)
         AND (? IS NULL OR r.item_id = ?) AND (? IS NULL OR r.id < ?)
         AND (? = 0 OR r.state IN (SELECT value FROM json_each(?)))
       ORDER BY r.id DESC LIMIT ?`
    )
    .all(
      ctx.hostId,
      scope.instanceId ?? null,
      scope.instanceId ?? null,
      query.itemId ?? null,
      query.itemId ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      states.length > 0 ? 1 : 0,
      JSON.stringify(states),
      size + 1
    )
  const runs = rows.slice(0, size).map(runFromRow)
  return { rows: runs, nextCursor: rows.length > size ? (runs.at(-1)?.id ?? null) : null }
}

export function listForgeChanges(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  query: { afterSeq: number; limit?: number }
): { changes: ForgeChange[]; nextSeq: number; hasMore: boolean } {
  const size = pageSize(query.limit)
  const rows = ctx.db
    .prepare(
      `SELECT * FROM changes WHERE host_id = ? AND (? IS NULL OR instance_id = ?) AND seq > ?
       ORDER BY seq LIMIT ?`
    )
    .all(ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null, query.afterSeq, size + 1)
  const changes = rows.slice(0, size).map(changeFromRow)
  return {
    changes,
    nextSeq: changes.at(-1)?.seq ?? query.afterSeq,
    hasMore: rows.length > size
  }
}

/** Only moves the client's own read mark; run state is untouched. */
export function markForgeItemRead(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  input: { clientId: string; itemId: number }
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare(
        `INSERT INTO item_reads (client_id, item_id, read_seq)
         SELECT ?, id, activity_seq FROM items
         WHERE id = ? AND host_id = ? AND (? IS NULL OR instance_id = ?)
         ON CONFLICT (client_id, item_id) DO UPDATE SET read_seq = excluded.read_seq
         WHERE excluded.read_seq > read_seq`
      )
      .run(
        input.clientId,
        input.itemId,
        ctx.hostId,
        scope.instanceId ?? null,
        scope.instanceId ?? null
      )
    if (Number(result.changes) > 0) {
      forgeCommitSignal(ctx.db).markRead(input.clientId)
      return true
    }
    // A repeat mark moves nothing, so it emits no hint, but the item still exists for the caller.
    return (
      ctx.db
        .prepare(
          `SELECT 1 AS found FROM items
           WHERE id = ? AND host_id = ? AND (? IS NULL OR instance_id = ?)`
        )
        .get(input.itemId, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null) !==
      undefined
    )
  })
}

export function setForgeClientCursor(
  ctx: ForgeLedgerContext,
  input: ForgeInstanceScope & { clientId: string; lastSeq: number }
): void {
  ctx.db
    .prepare(
      `INSERT INTO client_cursors (client_id, host_id, instance_id, last_seq) VALUES (?, ?, ?, ?)
       ON CONFLICT (client_id, host_id, instance_id)
       DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`
    )
    .run(input.clientId, ctx.hostId, input.instanceId ?? '', input.lastSeq)
}

export function getForgeClientCursor(
  ctx: ForgeLedgerContext,
  input: ForgeInstanceScope & { clientId: string }
): number {
  const row = ctx.db
    .prepare(
      'SELECT last_seq FROM client_cursors WHERE client_id = ? AND host_id = ? AND instance_id = ?'
    )
    .get(input.clientId, ctx.hostId, input.instanceId ?? '')
  return row ? rowNumber(row, 'last_seq') : 0
}

/** Latest durable change seq for the scope; it survives restarts, unlike any process counter. */
export function readForgeChangeHead(ctx: ForgeLedgerContext, scope: ForgeInstanceScope): number {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS head FROM changes
       WHERE host_id = ? AND (? IS NULL OR instance_id = ?)`
    )
    .get(ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
  return row ? rowNumber(row, 'head') : 0
}
