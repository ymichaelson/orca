import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber } from './forge-inbox-rows'

export const POLICY_GENERATION_OF_ITEM_SQL = `SELECT COALESCE(
  (SELECT p.generation FROM policies p JOIN items i
     ON i.instance_id = p.instance_id AND i.project_id = p.project_id
   WHERE i.id = proposals.item_id), 0)`

export function policyGenerationOfItem(ctx: ForgeLedgerContext, itemId: number): number {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE((SELECT p.generation FROM policies p JOIN items i
         ON i.instance_id = p.instance_id AND i.project_id = p.project_id
         WHERE i.id = ?), 0) AS generation`
    )
    .get(itemId)
  return row ? rowNumber(row, 'generation') : 0
}

/** Revokes every pending proposal of the project; later proposals bind to the new generation. */
export function bumpForgePolicyGeneration(
  ctx: ForgeLedgerContext,
  project: { instanceId: string; projectId: string }
): number {
  return runForgeTransaction(ctx.db, () => bumpForgePolicyGenerationInTransaction(ctx, project))
}

/** For callers that already hold the write transaction and must commit the bump atomically with it. */
export function bumpForgePolicyGenerationInTransaction(
  ctx: ForgeLedgerContext,
  project: { instanceId: string; projectId: string }
): number {
  ctx.db
    .prepare(
      `INSERT INTO policies (instance_id, project_id, generation) VALUES (?, ?, 1)
         ON CONFLICT (instance_id, project_id) DO UPDATE SET generation = generation + 1`
    )
    .run(project.instanceId, project.projectId)
  supersedeQueuedRuns(ctx, project)
  const revoked = ctx.db
    .prepare(
      `SELECT p.id, p.item_id FROM proposals p JOIN items i ON i.id = p.item_id
         WHERE p.status = 'pending' AND i.host_id = ? AND i.instance_id = ? AND i.project_id = ?`
    )
    .all(ctx.hostId, project.instanceId, project.projectId)
  for (const row of revoked) {
    const id = rowNumber(row, 'id')
    ctx.db
      .prepare("UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ?")
      .run(ctx.now(), id)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'proposal', id, 'stale')
  }
  const row = ctx.db
    .prepare('SELECT generation FROM policies WHERE instance_id = ? AND project_id = ?')
    .get(project.instanceId, project.projectId)
  return row ? rowNumber(row, 'generation') : 0
}

/** Queued runs were promised to the old policy; running ones are left for the coordinator to stop. */
function supersedeQueuedRuns(
  ctx: ForgeLedgerContext,
  project: { instanceId: string; projectId: string }
): void {
  const queued = ctx.db
    .prepare(
      `SELECT r.id, r.item_id FROM runs r JOIN items i ON i.id = r.item_id
         WHERE r.state = 'queued' AND i.host_id = ? AND i.instance_id = ? AND i.project_id = ?`
    )
    .all(ctx.hostId, project.instanceId, project.projectId)
  for (const row of queued) {
    const id = rowNumber(row, 'id')
    ctx.db
      .prepare(
        "UPDATE runs SET state = 'superseded', generation = generation + 1, updated_at = ? WHERE id = ?"
      )
      .run(ctx.now(), id)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'run', id, 'superseded')
  }
}
