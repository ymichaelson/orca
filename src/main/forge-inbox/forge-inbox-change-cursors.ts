import type { ForgeLedgerContext } from './forge-inbox-context'
import { changeFromRow, rowNumber } from './forge-inbox-rows'
import type { ForgeChange, ForgeInstanceScope } from './forge-inbox-types'
import { pageSize } from './forge-inbox-item-list-query'

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
