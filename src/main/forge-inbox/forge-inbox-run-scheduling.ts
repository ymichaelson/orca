import { runForgeTransaction } from './forge-inbox-database'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import { rowNumber } from './forge-inbox-rows'
import { applyTransition, readForgeRun } from './forge-inbox-runs'
import {
  FORGE_ANALYSIS_ITEM_KINDS,
  type ForgeInstanceScope,
  type ForgeRun
} from './forge-inbox-types'

/** A queued run is runnable only while its project has no live run and the host has capacity. */
const POLICY_GENERATION_SQL = `COALESCE((SELECT p.generation FROM policies p
  WHERE p.instance_id = i.instance_id AND p.project_id = i.project_id), 0)`

// A project item's dispatch runs are launched by the project event flow, never by this scheduler.
const ANALYSIS_KINDS_SQL = FORGE_ANALYSIS_ITEM_KINDS.map((kind) => `'${kind}'`).join(', ')

// Binding items follow the project event policy and launch their own agents; this retired
// scheduler's generation (0 for them) would otherwise supersede or cancel their live runs.
const LEGACY_ITEM_SQL = `NOT EXISTS (SELECT 1 FROM project_bindings pb
  WHERE i.instance_id = '${BINDING_INSTANCE_PREFIX}' || pb.gitlab_host AND i.project_id = pb.gitlab_path)`

export type ForgeRunSchedulingLimits = { maxConcurrentRuns: number }

export function claimNextRunnableForgeRun(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  limits: ForgeRunSchedulingLimits
): ForgeRun | null {
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT r.id FROM runs r
           JOIN items i ON i.id = r.item_id
           JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
          WHERE r.state = 'queued' AND i.host_id = ? AND i.kind IN (${ANALYSIS_KINDS_SQL})
            AND ${LEGACY_ITEM_SQL}
            AND (? IS NULL OR i.instance_id = ?)
            AND r.context_digest = head.version_token
            AND r.policy_generation = ${POLICY_GENERATION_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM runs live JOIN items li ON li.id = live.item_id
               WHERE live.state IN ('running', 'awaiting-approval')
                 AND li.host_id = i.host_id AND li.instance_id = i.instance_id
                 AND li.project_id = i.project_id)
            AND (SELECT COUNT(*) FROM runs lc JOIN items lci ON lci.id = lc.item_id
                  WHERE lc.state IN ('running', 'awaiting-approval') AND lci.host_id = ?) < ?
          ORDER BY r.id LIMIT 1`
      )
      .get(
        ctx.hostId,
        scope.instanceId ?? null,
        scope.instanceId ?? null,
        ctx.hostId,
        limits.maxConcurrentRuns
      )
    if (!row) {
      return null
    }
    const run = readForgeRun(ctx, rowNumber(row, 'id'))
    if (!run) {
      return null
    }
    const result = applyTransition(ctx, run, { to: 'running' })
    return result.ok ? result.run : null
  })
}

/** A head move or a policy bump leaves queued work that would analyse an obsolete snapshot. */
export function supersedeStaleForgeRuns(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope
): number {
  return runForgeTransaction(ctx.db, () =>
    retireRuns(
      ctx,
      scope,
      `r.state = 'queued' AND (r.context_digest <> head.version_token
         OR r.policy_generation <> ${POLICY_GENERATION_SQL})`,
      { to: 'superseded', error: undefined }
    )
  )
}

/** Running work keeps its old rules until the coordinator stops it; queued work is already superseded. */
export function cancelRevokedForgeRuns(ctx: ForgeLedgerContext, scope: ForgeInstanceScope): number {
  return runForgeTransaction(ctx.db, () =>
    retireRuns(
      ctx,
      scope,
      `r.state IN ('running', 'awaiting-approval') AND r.policy_generation <> ${POLICY_GENERATION_SQL}`,
      {
        to: 'cancelled',
        error: 'policy-revoked'
      }
    )
  )
}

export function forgeRunPolicyIsCurrent(ctx: ForgeLedgerContext, runId: number): boolean {
  const row = ctx.db
    .prepare(
      `SELECT r.id FROM runs r JOIN items i ON i.id = r.item_id
        WHERE r.id = ? AND r.policy_generation = ${POLICY_GENERATION_SQL}`
    )
    .get(runId)
  return row !== undefined
}

function retireRuns(
  ctx: ForgeLedgerContext,
  scope: ForgeInstanceScope,
  predicate: string,
  change: { to: 'superseded' | 'cancelled'; error: string | undefined }
): number {
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.item_id, r.generation FROM runs r
         JOIN items i ON i.id = r.item_id
         JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
        WHERE i.host_id = ? AND (? IS NULL OR i.instance_id = ?) AND ${LEGACY_ITEM_SQL}
          AND ${predicate}`
    )
    .all(ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
  let retired = 0
  for (const row of rows) {
    const updated = ctx.db
      .prepare(
        'UPDATE runs SET state = ?, generation = generation + 1, error = ?, updated_at = ? WHERE id = ? AND generation = ?'
      )
      .run(
        change.to,
        change.error ?? null,
        ctx.now(),
        rowNumber(row, 'id'),
        rowNumber(row, 'generation')
      )
    if (updated.changes !== 1) {
      continue
    }
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'run', rowNumber(row, 'id'), change.to)
    retired += 1
  }
  return retired
}
