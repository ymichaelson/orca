import type { ForgeLedgerContext } from './forge-inbox-context'
import type { ForgeArchiveView } from './forge-inbox-item-archive'
import type { ForgeInstanceScope, ForgeItemKind } from './forge-inbox-types'

export const FORGE_PAGE_MAX = 100
const FORGE_PAGE_DEFAULT = 50

export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return FORGE_PAGE_DEFAULT
  }
  return Math.min(Math.max(Math.floor(limit), 1), FORGE_PAGE_MAX)
}

/** Every item list narrows the same way, so a filtered list cannot drift from the plain one. */
export type ForgeItemListQuery = ForgeInstanceScope & {
  clientId: string
  unreadOnly?: boolean
  archiveView?: ForgeArchiveView
  /** One GitLab project path, as the item stored it. */
  projectId?: string
  kind?: ForgeItemKind
  limit?: number
  cursor?: number
}

/**
 * `extraColumns` carries per-row facts a caller still has to evaluate (handling state); `extraJoins`
 * carries whatever those columns read from.
 */
export function itemListSql(extra: { columns?: string; joins?: string } = {}): string {
  const columns = extra.columns === undefined ? '' : `, ${extra.columns}`
  const joins = extra.joins === undefined ? '' : ` ${extra.joins}`
  return `SELECT i.*, r.read_seq AS read_seq, a.archived_seq AS archived_seq${columns} FROM items i
       LEFT JOIN item_reads r ON r.item_id = i.id AND r.client_id = ?
       LEFT JOIN item_archives a ON a.item_id = i.id AND a.client_id = ?${joins}
       WHERE i.host_id = ? AND (? IS NULL OR i.instance_id = ?)
         AND (? IS NULL OR i.id < ?)
         AND (? IS NULL OR i.project_id = ?)
         AND (? IS NULL OR i.kind = ?)
         AND (? = 0 OR r.read_seq IS NULL OR r.read_seq < i.activity_seq)
         AND (? = 'all'
           OR (a.archived_seq IS NOT NULL AND a.archived_seq >= i.activity_seq) = (? = 'archived'))`
}

/** Positional values for `itemListSql`, in the same order. */
export function itemListParams(
  ctx: ForgeLedgerContext,
  query: ForgeItemListQuery
): (string | number | null)[] {
  return [
    query.clientId,
    query.clientId,
    ctx.hostId,
    query.instanceId ?? null,
    query.instanceId ?? null,
    query.cursor ?? null,
    query.cursor ?? null,
    query.projectId ?? null,
    query.projectId ?? null,
    query.kind ?? null,
    query.kind ?? null,
    query.unreadOnly ? 1 : 0,
    query.archiveView ?? 'active',
    query.archiveView ?? 'active'
  ]
}
