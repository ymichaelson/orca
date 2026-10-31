import type { ForgeInboxListItem } from '../../shared/forge-inbox-rpc-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import type { ForgeItemHandlingState } from '../../shared/forge-inbox-item-handling'
import { itemFromRowWithMarks } from './forge-inbox-item-archive'
import {
  forgeListItemStatusOf,
  handlingJoinsSql,
  handlingSelectSql
} from './forge-inbox-item-handling'
import {
  itemListParams,
  itemListSql,
  pageSize,
  type ForgeItemListQuery
} from './forge-inbox-item-list-query'
import { rowNumber } from './forge-inbox-rows'
import type { ForgePage } from './forge-inbox-types'
import type { SqliteRow } from '../sqlite/sqlite-statement'

/** A list row carries what it is doing, so it can label itself without opening the item. */
export function forgeListItemFromRow(row: SqliteRow): ForgeInboxListItem {
  const { handling, latestRunState, recommendationAction } = forgeListItemStatusOf(row)
  return {
    ...itemFromRowWithMarks(row),
    handling,
    ...(latestRunState === null ? {} : { latestRunState }),
    ...(recommendationAction === null ? {} : { recommendationAction })
  }
}

/** One batch per read keeps a filtered page from loading the whole ledger at once. */
const HANDLING_SCAN_BATCH = 100
/** Past this many scanned items an unfillable page ends instead of scanning forever. */
const HANDLING_SCAN_MAX = 1000

/**
 * Handling is derived, never stored, so this reads item rows in id order and keeps the ones whose
 * canonical state matches. Pages stay complete: the cursor only advances past rows actually read.
 */
export function listForgeItemsByHandling(
  ctx: ForgeLedgerContext,
  query: ForgeItemListQuery & { handling: ForgeItemHandlingState }
): ForgePage<ForgeInboxListItem> {
  const size = pageSize(query.limit)
  const read = ctx.db.prepare(
    `${itemListSql({ columns: handlingSelectSql(), joins: handlingJoinsSql() })}
       ORDER BY i.id DESC LIMIT ?`
  )
  const matches: ForgeInboxListItem[] = []
  let cursor = query.cursor ?? null
  let scanned = 0
  let exhausted = false
  // Why: one extra match proves another page exists without reading the whole narrowing.
  while (matches.length <= size && scanned < HANDLING_SCAN_MAX) {
    const take = Math.min(HANDLING_SCAN_BATCH, HANDLING_SCAN_MAX - scanned)
    const batch = read.all(...itemListParams(ctx, { ...query, cursor: cursor ?? undefined }), take)
    scanned += batch.length
    for (const row of batch) {
      cursor = rowNumber(row, 'id')
      const item = forgeListItemFromRow(row)
      if (item.handling?.state === query.handling) {
        matches.push(item)
      }
    }
    // Why: a short batch is the end of the narrowing, so a further read could only repeat it.
    exhausted = batch.length < take
    if (exhausted) {
      break
    }
  }
  const rows = matches.slice(0, size)
  // Why: resuming after the last returned row re-reads nothing and still reaches the extra match.
  const nextCursor = matches.length > size ? (rows.at(-1)?.id ?? null) : exhausted ? null : cursor
  return { rows, nextCursor }
}
