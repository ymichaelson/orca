import type { SecretStore } from '../../shared/secret-store'
import type Database from '../sqlite/sync-database'
import { forgeCommitSignal } from './forge-inbox-commit-signal'
import { rowNumber } from './forge-inbox-rows'

export type ForgeLedgerContext = {
  db: Database.Database
  /** The persisted owner identity of this ledger; every read and write is bound to it. */
  hostId: string
  now: () => number
  /** Resolved per operation so a host that installs its store after opening still seals. */
  secretStore: () => SecretStore
}

/** Appends to the monotonic feed; AUTOINCREMENT keeps seq from ever being reused. */
export function recordForgeChange(
  ctx: ForgeLedgerContext,
  itemId: number,
  entity: 'event' | 'run' | 'proposal' | 'receipt',
  entityId: number,
  change: string
): number {
  const result = ctx.db
    .prepare(
      `INSERT INTO changes (host_id, instance_id, item_id, entity, entity_id, change, created_at)
       SELECT host_id, instance_id, id, ?, ?, ?, ? FROM items WHERE id = ?`
    )
    .run(entity, entityId, change, ctx.now(), itemId)
  if (result.changes !== 1) {
    throw new Error(`forge inbox item ${itemId} does not exist`)
  }
  forgeCommitSignal(ctx.db).markChanges()
  const seq = rowNumber({ v: result.lastInsertRowid }, 'v')
  // Any lifecycle change is item activity, so a client that already read the item sees it as unread.
  ctx.db
    .prepare('UPDATE items SET activity_seq = MAX(activity_seq, ?) WHERE id = ?')
    .run(seq, itemId)
  return seq
}
