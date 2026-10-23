import type { ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeItemKey } from './forge-inbox-types'

export type ForgeItemWatermark = { headOrder: number; versionToken: string | null }

export function readForgeItemWatermark(
  ctx: ForgeLedgerContext,
  key: Omit<ForgeItemKey, 'hostId'>
): ForgeItemWatermark | null {
  const row = ctx.db
    .prepare(
      `SELECT i.head_order, r.version_token FROM items i
       LEFT JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
       WHERE i.host_id = ? AND i.instance_id = ? AND i.project_id = ? AND i.kind = ? AND i.iid = ?`
    )
    .get(ctx.hostId, key.instanceId, key.projectId, key.kind, key.iid)
  if (!row) {
    return null
  }
  return {
    headOrder: rowNumber(row, 'head_order'),
    versionToken: row.version_token === null ? null : rowText(row, 'version_token')
  }
}
