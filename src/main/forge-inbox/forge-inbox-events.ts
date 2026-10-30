import type { ForgeLedgerContext } from './forge-inbox-context'
import { summarizeForgeEventPayload } from './forge-inbox-event-summary'
import { rowNumber, rowText } from './forge-inbox-rows'
import { FORGE_PAGE_MAX } from './forge-inbox-item-list-query'
import type { ForgeEvent, ForgeInstanceScope, ForgePage } from './forge-inbox-types'

/** Newest first; `cursor` is the id of the last event already seen. */
export function listForgeEvents(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  query: { itemId: number; limit?: number; cursor?: number }
): ForgePage<ForgeEvent> {
  const size = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), FORGE_PAGE_MAX)
  const rows = ctx.db
    .prepare(
      `SELECT e.* FROM events e JOIN items i ON i.id = e.item_id
       WHERE e.item_id = ? AND i.host_id = ? AND (? IS NULL OR i.instance_id = ?)
         AND (? IS NULL OR e.id < ?)
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(
      query.itemId,
      ctx.hostId,
      scope.instanceId ?? null,
      scope.instanceId ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      size + 1
    )
  const page = rows.slice(0, size).map((row) => ({
    id: rowNumber(row, 'id'),
    itemId: rowNumber(row, 'item_id'),
    revision: rowNumber(row, 'revision'),
    eventKind: rowText(row, 'event_kind'),
    versionToken: rowText(row, 'version_token'),
    sourceOrder: rowNumber(row, 'source_order'),
    receivedAt: rowNumber(row, 'received_at'),
    summary: summarizeForgeEventPayload(rowText(row, 'payload_json'))
  }))
  return { rows: page, nextCursor: rows.length > size ? (page.at(-1)?.id ?? null) : null }
}
