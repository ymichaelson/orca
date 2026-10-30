import { forgeProjectPolicyPatchSchema } from '../../shared/forge-inbox-project-policy-patch'
import {
  parseProjectEventPolicyBody,
  type ProjectEventPolicyBody,
  type ProjectEventPolicyView
} from '../../shared/forge-inbox-project-event-policy'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import {
  mintRunCancelOperationId,
  OPEN_DISPATCH_RUN_SQL
} from './forge-inbox-project-event-run-cancel-state'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'
import { rowNumber, rowText } from './forge-inbox-rows'

export type ProjectEventPolicyUpdateResult =
  | { ok: true; generation: number; policy: ProjectEventPolicyView }
  | { ok: false; reason: 'stale-generation'; generation: number }
  | { ok: false; reason: 'invalid-policy'; message: string }

function mergeDefined<T extends object>(base: T, patch: object | undefined): T {
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) {
      Object.defineProperty(merged, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
  }
  return merged
}

function viewOf(repoId: string, policy: ProjectEventPolicyBody, generation: number) {
  return { repoId, ...policy, generation }
}

function policyFromRow(repoId: string, row: SqliteRow): ProjectEventPolicyView {
  const generation = rowNumber(row, 'generation')
  let stored: unknown
  try {
    stored = JSON.parse(rowText(row, 'policy_json'))
  } catch {
    throw new Error(`project event policy for ${repoId} is unreadable`)
  }
  const parsed = parseProjectEventPolicyBody(stored)
  if (!parsed.ok) {
    throw new Error(`project event policy for ${repoId} is invalid: ${parsed.message}`)
  }
  return viewOf(repoId, parsed.policy, generation)
}

export function getProjectEventPolicy(
  ctx: ForgeLedgerContext,
  repoId: string
): ProjectEventPolicyView | null {
  const row = ctx.db
    .prepare(
      'SELECT policy_json, generation FROM project_event_policies WHERE host_id = ? AND repo_id = ?'
    )
    .get(ctx.hostId, repoId)
  return row ? policyFromRow(repoId, row) : null
}

/** Items ingested from binding deliveries are identified by GitLab host and path, not a config instance. */
const BINDING_ITEM_JOIN = `JOIN project_bindings b
    ON i.instance_id = '${BINDING_INSTANCE_PREFIX}' || b.gitlab_host AND i.project_id = b.gitlab_path
  JOIN project_event_repo_links l ON l.binding_id = b.binding_id AND l.host_id = i.host_id`

/** Null for an item that no project binding owns, so callers can fall back to the retired table. */
export function projectEventPolicyGenerationOfItem(
  ctx: ForgeLedgerContext,
  itemId: number
): number | null {
  const row = ctx.db
    .prepare(
      `SELECT p.generation AS generation FROM items i
       ${BINDING_ITEM_JOIN}
       JOIN project_event_policies p ON p.host_id = i.host_id AND p.repo_id = l.repo_id
       WHERE i.id = ? AND i.host_id = ?`
    )
    .get(itemId, ctx.hostId)
  return row ? rowNumber(row, 'generation') : null
}

export function listProjectEventPolicies(ctx: ForgeLedgerContext): ProjectEventPolicyView[] {
  return ctx.db
    .prepare(
      'SELECT repo_id, policy_json, generation FROM project_event_policies WHERE host_id = ? ORDER BY repo_id'
    )
    .all(ctx.hostId)
    .map((row) => policyFromRow(rowText(row, 'repo_id'), row))
}

/** Synchronous by design: the policy commits before any glab identity or network work starts. */
export function updateProjectEventPolicy(
  ctx: ForgeLedgerContext,
  input: { repoId: string; expectedGeneration: number; patch: unknown }
): ProjectEventPolicyUpdateResult {
  const patch = forgeProjectPolicyPatchSchema.safeParse(input.patch)
  if (!patch.success) {
    return { ok: false, reason: 'invalid-policy', message: patch.error.message }
  }
  return runForgeTransaction(ctx.db, (): ProjectEventPolicyUpdateResult => {
    const current = getProjectEventPolicy(ctx, input.repoId)
    const currentGeneration = current?.generation ?? 0
    if (input.expectedGeneration !== currentGeneration) {
      return { ok: false, reason: 'stale-generation', generation: currentGeneration }
    }
    const { agentId, model, rules, enabled, automaticAnalysis, events, budgets } = patch.data
    const base: ProjectEventPolicyBody = current ?? {
      agentId: null,
      model: null,
      rules: '',
      enabled: false,
      automaticAnalysis: false,
      events: {
        reviewRequests: false,
        participatingMergeRequestUpdates: false,
        pipelineFailures: false,
        issueMentions: false,
        issueAssignments: false
      },
      budgets: {
        timeoutSeconds: 600,
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        maxRunsPerHour: 12,
        maxConcurrentRuns: 1
      }
    }
    const merged: ProjectEventPolicyBody = {
      agentId: agentId === undefined ? base.agentId : agentId,
      model: model === undefined ? base.model : model,
      rules: rules ?? base.rules,
      enabled: enabled ?? base.enabled,
      automaticAnalysis: automaticAnalysis ?? base.automaticAnalysis,
      events: mergeDefined(base.events, events),
      budgets: mergeDefined(base.budgets, budgets)
    }
    const parsed = parseProjectEventPolicyBody(merged)
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid-policy', message: parsed.message }
    }
    if (current && JSON.stringify(parsed.policy) === JSON.stringify(currentBody(current))) {
      return { ok: true, generation: current.generation, policy: current }
    }
    const generation = currentGeneration + 1
    ctx.db
      .prepare(
        `INSERT INTO project_event_policies (host_id, repo_id, policy_json, generation, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (host_id, repo_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           generation = excluded.generation,
           updated_at = excluded.updated_at`
      )
      .run(ctx.hostId, input.repoId, JSON.stringify(parsed.policy), generation, ctx.now())
    supersedeWorkForRepoInTransaction(ctx, input.repoId)
    if (current && changesDispatchOutcome(currentBody(current), parsed.policy)) {
      requestActiveDispatchCancellationInTransaction(ctx, input.repoId, generation)
    }
    return { ok: true, generation, policy: viewOf(input.repoId, parsed.policy, generation) }
  })
}

/** Work promised to the old rules must not keep writing: queued runs and pending drafts are revoked. */
function supersedeWorkForRepoInTransaction(ctx: ForgeLedgerContext, repoId: string): void {
  const queued = ctx.db
    .prepare(
      `SELECT r.id AS run_id, r.item_id FROM runs r JOIN items i ON i.id = r.item_id
       ${BINDING_ITEM_JOIN}
       WHERE r.state = 'queued' AND i.host_id = ? AND l.repo_id = ?`
    )
    .all(ctx.hostId, repoId)
  for (const row of queued) {
    const id = rowNumber(row, 'run_id')
    ctx.db
      .prepare(
        "UPDATE runs SET state = 'superseded', generation = generation + 1, updated_at = ? WHERE id = ?"
      )
      .run(ctx.now(), id)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'run', id, 'superseded')
  }
  const proposals = ctx.db
    .prepare(
      `SELECT p.id AS proposal_id, p.item_id FROM proposals p JOIN items i ON i.id = p.item_id
       ${BINDING_ITEM_JOIN}
       WHERE p.status = 'pending' AND i.host_id = ? AND l.repo_id = ?`
    )
    .all(ctx.hostId, repoId)
  for (const row of proposals) {
    const id = rowNumber(row, 'proposal_id')
    ctx.db
      .prepare("UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ?")
      .run(ctx.now(), id)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'proposal', id, 'stale')
  }
}

/** Only what a dispatched agent was told or runs as; budgets and event toggles leave it running. */
function changesDispatchOutcome(before: ProjectEventPolicyBody, after: ProjectEventPolicyBody) {
  return (
    before.agentId !== after.agentId ||
    before.model !== after.model ||
    before.rules !== after.rules ||
    (before.enabled && !after.enabled)
  )
}

/** The stop is committed with the policy, so no restart or crash can lose it; delivery happens after. */
function requestActiveDispatchCancellationInTransaction(
  ctx: ForgeLedgerContext,
  repoId: string,
  policyGeneration: number
): void {
  const active = ctx.db
    .prepare(
      `SELECT r.id AS run_id, r.item_id FROM runs r JOIN items i ON i.id = r.item_id
       ${BINDING_ITEM_JOIN}
       WHERE r.reason = ? AND r.cancel_requested_at IS NULL AND ${OPEN_DISPATCH_RUN_SQL}
         AND i.host_id = ? AND l.repo_id = ?`
    )
    .all(PROJECT_EVENT_DISPATCH_RUN_REASON, ctx.hostId, repoId)
  for (const row of active) {
    const id = rowNumber(row, 'run_id')
    ctx.db
      .prepare(
        `UPDATE runs SET cancel_requested_at = ?, cancel_operation_id = ?,
           cancel_policy_generation = ?, updated_at = ? WHERE id = ?`
      )
      .run(ctx.now(), mintRunCancelOperationId(), policyGeneration, ctx.now(), id)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'run', id, 'cancel-requested')
  }
}

function currentBody(policy: ProjectEventPolicyView): ProjectEventPolicyBody {
  const { repoId: _repoId, generation: _generation, ...body } = policy
  return body
}
