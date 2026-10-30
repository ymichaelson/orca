import {
  isProjectEventBindingId,
  PROJECT_EVENT_BINDING_FAILURE_PHASES,
  PROJECT_EVENT_BINDING_STATES,
  type ProjectEventBindingFailure,
  type ProjectEventBindingFailurePhase,
  type ProjectEventBindingSecretProtection,
  type ProjectEventBindingState,
  type ProjectEventBindingView
} from '../../shared/forge-inbox-project-binding'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { rowNumber, rowText } from './forge-inbox-rows'

export type ProjectBindingIdentityInput = {
  bindingId: string
  projectPath: string
  gitlabHost: string
  gitlabPath: string
  gitlabProjectId: number
  callbackUrl: string
}

/** Items and deliveries admitted through a binding carry this instead of a configured instance id. */
export const BINDING_INSTANCE_PREFIX = 'gitlab:'

export type ProjectBindingFailureInput = {
  phase: ProjectEventBindingFailurePhase
  code: string
  retryable: boolean
}

export type ProjectBindingProgress = {
  state: ProjectEventBindingState
  hookId?: number | null
  failure?: ProjectBindingFailureInput | null
  /** Replaced when provided; omitted leaves the stored list untouched. */
  rejectedEvents?: string[]
}

function optionalNumber(row: SqliteRow, column: string): number | null {
  return row[column] === null ? null : rowNumber(row, column)
}

function optionalText(row: SqliteRow, column: string): string | null {
  return row[column] === null ? null : rowText(row, column)
}

function stateFrom(row: SqliteRow): ProjectEventBindingState {
  const value = rowText(row, 'state')
  const match = PROJECT_EVENT_BINDING_STATES.find((state) => state === value)
  if (match === undefined) {
    throw new Error(`project_bindings.state holds unknown value ${value}`)
  }
  return match
}

function failurePhaseFrom(value: string | null): ProjectEventBindingFailurePhase | null {
  if (value === null) {
    return null
  }
  const match = PROJECT_EVENT_BINDING_FAILURE_PHASES.find((phase) => phase === value)
  if (match === undefined) {
    throw new Error(`project_bindings.failure_phase holds unknown value ${value}`)
  }
  return match
}

function protectionFrom(row: SqliteRow): ProjectEventBindingSecretProtection | null {
  const value = optionalText(row, 'secret_protection')
  if (value === null) {
    return null
  }
  if (value !== 'sealed' && value !== 'plaintext') {
    throw new Error(`project_bindings.secret_protection holds unknown value ${value}`)
  }
  return value
}

function rejectedEventsFrom(row: SqliteRow): string[] {
  const text = optionalText(row, 'rejected_events_json')
  if (text === null) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : []
  } catch {
    return []
  }
}

function bindingFromRow(row: SqliteRow): ProjectEventBindingView {
  const failure: ProjectEventBindingFailure | null = (() => {
    const phase = failurePhaseFrom(optionalText(row, 'failure_phase'))
    const code = optionalText(row, 'failure_code')
    const failedAt = optionalNumber(row, 'failed_at')
    if (phase === null || code === null || failedAt === null) {
      return null
    }
    return { phase, code, failedAt, retryable: rowNumber(row, 'retryable') === 1 }
  })()
  return {
    bindingId: rowText(row, 'binding_id'),
    projectPath: rowText(row, 'project_path'),
    gitlabHost: rowText(row, 'gitlab_host'),
    gitlabPath: rowText(row, 'gitlab_path'),
    gitlabProjectId: rowNumber(row, 'gitlab_project_id'),
    callbackUrl: rowText(row, 'callback_url'),
    hookId: optionalNumber(row, 'hook_id'),
    state: stateFrom(row),
    failure,
    secretProtection: protectionFrom(row),
    rejectedEvents: rejectedEventsFrom(row),
    rotationPending: row.pending_secret_envelope !== null,
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at')
  }
}

function mustGetProjectBinding(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectEventBindingView {
  const row = ctx.db.prepare('SELECT * FROM project_bindings WHERE binding_id = ?').get(bindingId)
  if (!row) {
    throw new Error(`project binding ${bindingId} does not exist`)
  }
  return bindingFromRow(row)
}

export function upsertProjectBinding(
  ctx: ForgeLedgerContext,
  input: ProjectBindingIdentityInput
): ProjectEventBindingView {
  if (!isProjectEventBindingId(input.bindingId)) {
    throw new Error('a project binding id must be a uuid')
  }
  return runForgeTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO project_bindings (binding_id, project_path, gitlab_host, gitlab_path,
           gitlab_project_id, callback_url, hook_id, state, failure_phase, failure_code, failed_at,
           retryable, secret_protection, secret_gap, secret_envelope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'unconfigured', NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?)
         ON CONFLICT (binding_id) DO UPDATE SET
           gitlab_host = excluded.gitlab_host,
           gitlab_path = excluded.gitlab_path,
           gitlab_project_id = excluded.gitlab_project_id,
           callback_url = excluded.callback_url,
           updated_at = excluded.updated_at`
      )
      .run(
        input.bindingId,
        input.projectPath,
        input.gitlabHost,
        input.gitlabPath,
        input.gitlabProjectId,
        input.callbackUrl,
        ctx.now(),
        ctx.now()
      )
    return mustGetProjectBinding(ctx, input.bindingId)
  })
}

export function getProjectBinding(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectEventBindingView | null {
  const row = ctx.db.prepare('SELECT * FROM project_bindings WHERE binding_id = ?').get(bindingId)
  return row ? bindingFromRow(row) : null
}

export function getProjectBindingByGitlab(
  ctx: ForgeLedgerContext,
  gitlabHost: string,
  gitlabProjectId: number
): ProjectEventBindingView | null {
  const row = ctx.db
    .prepare('SELECT * FROM project_bindings WHERE gitlab_host = ? AND gitlab_project_id = ?')
    .get(gitlabHost, gitlabProjectId)
  return row ? bindingFromRow(row) : null
}

/** A renamed project can leave two rows on one path, so only an unambiguous path resolves. */
export function getProjectBindingByGitlabPath(
  ctx: ForgeLedgerContext,
  gitlabHost: string,
  gitlabPath: string
): ProjectEventBindingView | null {
  const rows = ctx.db
    .prepare('SELECT * FROM project_bindings WHERE gitlab_host = ? AND gitlab_path = ? LIMIT 2')
    .all(gitlabHost, gitlabPath)
  const [row, other] = rows
  return row !== undefined && other === undefined ? bindingFromRow(row) : null
}

export function listProjectBindings(ctx: ForgeLedgerContext): ProjectEventBindingView[] {
  return ctx.db
    .prepare('SELECT * FROM project_bindings ORDER BY created_at, binding_id')
    .all()
    .map(bindingFromRow)
}

/** A crashed reconcile has no reader left to fail it, so opening the ledger does; only the owner may open it, so no live reconcile can be mid-flight. */
export function markInterruptedProjectBindingsFailed(ctx: ForgeLedgerContext): number {
  return runForgeTransaction(ctx.db, () => {
    const failedAt = ctx.now()
    return Number(
      ctx.db
        .prepare(
          `UPDATE project_bindings SET state = 'failed', failure_phase = state,
             failure_code = 'interrupted', failed_at = ?, retryable = 1, updated_at = ?
           WHERE state IN ('checking', 'registering', 'verifying')`
        )
        .run(failedAt, failedAt).changes
    )
  })
}

export function removeProjectBinding(ctx: ForgeLedgerContext, bindingId: string): boolean {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare('DELETE FROM project_bindings WHERE binding_id = ?')
      .run(bindingId)
    return result.changes > 0
  })
}

function validatedFailure(progress: ProjectBindingProgress): ProjectBindingFailureInput | null {
  if (progress.state !== 'failed') {
    return null
  }
  const failure = progress.failure
  if (
    !failure ||
    !PROJECT_EVENT_BINDING_FAILURE_PHASES.includes(failure.phase) ||
    typeof failure.code !== 'string'
  ) {
    throw new Error('a failed project binding needs a failure with a phase and code')
  }
  return failure
}

function assertValidHookId(hookId: number | null | undefined): void {
  if (hookId !== undefined && hookId !== null && (!Number.isSafeInteger(hookId) || hookId <= 0)) {
    throw new Error('a project binding hook id must be a positive integer')
  }
}

export function setProjectBindingProgress(
  ctx: ForgeLedgerContext,
  bindingId: string,
  progress: ProjectBindingProgress
): ProjectEventBindingView {
  const failure = validatedFailure(progress)
  assertValidHookId(progress.hookId)
  return runForgeTransaction(ctx.db, () => {
    const existing = getProjectBinding(ctx, bindingId)
    if (!existing) {
      throw new Error(`project binding ${bindingId} does not exist`)
    }
    const hookId = progress.hookId === undefined ? existing.hookId : progress.hookId
    const rejected = JSON.stringify(progress.rejectedEvents ?? existing.rejectedEvents)
    ctx.db
      .prepare(
        `UPDATE project_bindings SET state = ?, hook_id = ?, failure_phase = ?, failure_code = ?,
           failed_at = ?, retryable = ?, rejected_events_json = ?, updated_at = ?
         WHERE binding_id = ?`
      )
      .run(
        progress.state,
        hookId,
        failure?.phase ?? null,
        failure?.code ?? null,
        failure ? ctx.now() : null,
        failure?.retryable ? 1 : 0,
        rejected === '[]' ? null : rejected,
        ctx.now(),
        bindingId
      )
    return mustGetProjectBinding(ctx, bindingId)
  })
}
