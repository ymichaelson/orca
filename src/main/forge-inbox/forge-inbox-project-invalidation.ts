import type { ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber } from './forge-inbox-rows'

type ProjectScope = { instanceId: string; projectId: string }

export function readForgeProjectInvalidationGeneration(
  ctx: ForgeLedgerContext,
  project: ProjectScope
): number {
  const row = ctx.db
    .prepare(
      `SELECT generation FROM project_invalidations
       WHERE host_id = ? AND instance_id = ? AND project_id = ?`
    )
    .get(ctx.hostId, project.instanceId, project.projectId)
  return row ? rowNumber(row, 'generation') : 0
}

export function invalidateForgeProjectInTransaction(
  ctx: ForgeLedgerContext,
  project: ProjectScope
): void {
  const generation = readForgeProjectInvalidationGeneration(ctx, project) + 1
  if (!Number.isSafeInteger(generation)) {
    throw new Error('forge inbox project invalidation generation exhausted')
  }
  ctx.db
    .prepare(
      `INSERT INTO project_invalidations (host_id, instance_id, project_id, generation)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (host_id, instance_id, project_id) DO UPDATE SET generation = excluded.generation`
    )
    .run(ctx.hostId, project.instanceId, project.projectId, generation)
}
