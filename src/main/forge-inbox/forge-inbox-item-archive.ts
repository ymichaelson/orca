import { forgeCommitSignal } from './forge-inbox-commit-signal'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { itemFromRow, rowNumber } from './forge-inbox-rows'
import type { ForgeItem, ForgeInstanceScope } from './forge-inbox-types'

export type ForgeArchiveView = 'active' | 'archived' | 'all'

type ItemRow = Parameters<typeof itemFromRow>[0]

export function itemFromRowWithMarks(row: ItemRow): ForgeItem {
  return itemFromRow(
    row,
    row.read_seq === null ? null : rowNumber(row, 'read_seq'),
    row.archived_seq === null ? null : rowNumber(row, 'archived_seq')
  )
}

function itemExists(ctx: ForgeLedgerContext, scope: ForgeInstanceScope, itemId: number): boolean {
  return (
    ctx.db
      .prepare(
        `SELECT 1 AS found FROM items
         WHERE id = ? AND host_id = ? AND (? IS NULL OR instance_id = ?)`
      )
      .get(itemId, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null) !== undefined
  )
}

/** Moves only this reader's archive mark; it never advances item activity or the change feed. */
export function archiveForgeItem(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  input: { clientId: string; itemId: number }
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare(
        `INSERT INTO item_archives (client_id, item_id, archived_seq)
         SELECT ?, id, activity_seq FROM items
         WHERE id = ? AND host_id = ? AND (? IS NULL OR instance_id = ?)
         ON CONFLICT (client_id, item_id) DO UPDATE SET archived_seq = excluded.archived_seq
         WHERE excluded.archived_seq > archived_seq`
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
    return itemExists(ctx, scope, input.itemId)
  })
}

export function unarchiveForgeItem(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  input: { clientId: string; itemId: number }
): boolean {
  return runForgeTransaction(ctx.db, () => {
    if (!itemExists(ctx, scope, input.itemId)) {
      return false
    }
    const result = ctx.db
      .prepare('DELETE FROM item_archives WHERE client_id = ? AND item_id = ?')
      .run(input.clientId, input.itemId)
    if (Number(result.changes) > 0) {
      forgeCommitSignal(ctx.db).markRead(input.clientId)
    }
    return true
  })
}
