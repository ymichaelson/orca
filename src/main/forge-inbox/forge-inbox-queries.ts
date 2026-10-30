import { forgeCommitSignal } from './forge-inbox-commit-signal'
import { runForgeTransaction } from './forge-inbox-database'
import type { ForgeDispatchConfirmationView } from '../../shared/forge-inbox-dispatch-confirmation'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { readDispatchConfirmationViews } from './forge-inbox-dispatch-confirmation-view'
import { readRunCancellationViews } from './forge-inbox-project-event-run-cancel-state'
import { readRunDispatchFacts, type ForgeRunDispatchFacts } from './forge-inbox-run-dispatch-view'
import type { ForgeRunCancellationView } from '../../shared/forge-inbox-run-cancellation'
import { itemFromRowWithMarks } from './forge-inbox-item-archive'
import { readForgeItemHandling } from './forge-inbox-item-handling'
import { listForgeItemsByHandling } from './forge-inbox-item-handling-list'
import {
  FORGE_PAGE_MAX,
  itemListParams,
  itemListSql,
  pageSize
} from './forge-inbox-item-list-query'
import type { ForgeItemListQuery } from './forge-inbox-item-list-query'
import { readForgeItemTimeline } from './forge-inbox-item-timeline'
import {
  BINDING_INSTANCE_PREFIX,
  getProjectBindingByGitlabPath
} from './forge-inbox-project-binding'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import type {
  ForgeItemHandlingState,
  ForgeItemHandlingView
} from '../../shared/forge-inbox-item-handling'
import type { ForgeItemTimelineEntry } from '../../shared/forge-inbox-item-timeline'
import { itemFromRow, proposalFromRow, rowNumber, runFromRow } from './forge-inbox-rows'
import type {
  ForgeItem,
  ForgePage,
  ForgeProposal,
  ForgeRevision,
  ForgeRun,
  ForgeRunState,
  ForgeInstanceScope
} from './forge-inbox-types'

/**
 * Ordered by immutable item id (newest created first) so later activity can never skip or repeat
 * a row between pages; `activitySeq` and the changes feed carry recency. `cursor` is the last id seen.
 */
export function listForgeItems(
  ctx: ForgeLedgerContext,
  query: ForgeItemListQuery & { handling?: ForgeItemHandlingState }
): ForgePage<ForgeItem> {
  if (query.handling !== undefined) {
    return listForgeItemsByHandling(ctx, { ...query, handling: query.handling })
  }
  const size = pageSize(query.limit)
  const rows = ctx.db
    .prepare(`${itemListSql()} ORDER BY i.id DESC LIMIT ?`)
    .all(...itemListParams(ctx, query), size + 1)
  const items = rows.slice(0, size).map((row) => itemFromRowWithMarks(row))
  return {
    rows: items,
    nextCursor: rows.length > size ? (items.at(-1)?.id ?? null) : null
  }
}

/** Every project this host holds an item for, so a client can offer the filter without guessing. */
export function listForgeItemProjects(ctx: ForgeLedgerContext): string[] {
  return ctx.db
    .prepare(`SELECT DISTINCT project_id FROM items WHERE host_id = ? ORDER BY project_id LIMIT ?`)
    .all(ctx.hostId, FORGE_PAGE_MAX)
    .map((row) => String(row.project_id))
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
  /** Already allowlisted views by run id; a run that dispatched nothing has none. */
  dispatchConfirmations?: ReadonlyMap<number, ForgeDispatchConfirmationView>
  /** Already allowlisted views by run id; only runs someone asked to stop have one. */
  cancellations?: ReadonlyMap<number, ForgeRunCancellationView>
  /** Already allowlisted facts by run id: the dispatch snapshot and the terminal exit, when recorded. */
  dispatchFacts?: ReadonlyMap<number, ForgeRunDispatchFacts>
  proposals: ForgeProposal[]
  handling: ForgeItemHandlingView
  timeline: ForgeItemTimelineEntry[]
  repoId?: string | null
}

export function getForgeItemDetail(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  itemId: number,
  clientId: string
): ForgeItemDetail | null {
  const row = ctx.db
    .prepare(
      `SELECT i.*, r.read_seq AS read_seq, a.archived_seq AS archived_seq FROM items i
       LEFT JOIN item_reads r ON r.item_id = i.id AND r.client_id = ?
       LEFT JOIN item_archives a ON a.item_id = i.id AND a.client_id = ?
       WHERE i.id = ? AND i.host_id = ? AND (? IS NULL OR i.instance_id = ?)`
    )
    .get(clientId, clientId, itemId, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
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
  const item = itemFromRowWithMarks(row)
  const binding = item.instanceId.startsWith(BINDING_INSTANCE_PREFIX)
    ? getProjectBindingByGitlabPath(
        ctx,
        item.instanceId.slice(BINDING_INSTANCE_PREFIX.length),
        item.projectId
      )
    : null
  const repoId =
    binding === null
      ? null
      : (getProjectEventRepoLinkByBinding(ctx, binding.bindingId)?.repoId ?? null)
  const runs = listForgeRuns(ctx, scope, { itemId, limit: FORGE_PAGE_MAX }).rows
  return {
    item,
    repoId,
    revisions,
    runs,
    dispatchConfirmations: readDispatchConfirmationViews(
      ctx,
      runs.map((run) => run.id)
    ),
    cancellations: readRunCancellationViews(
      ctx,
      runs.map((run) => run.id)
    ),
    dispatchFacts: readRunDispatchFacts(
      ctx,
      runs.map((run) => run.id)
    ),
    proposals,
    handling: readForgeItemHandling(ctx, itemId),
    timeline: readForgeItemTimeline(ctx, itemId)
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
