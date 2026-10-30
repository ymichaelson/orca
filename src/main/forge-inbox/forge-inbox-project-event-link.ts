import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { rowNumber, rowText } from './forge-inbox-rows'

export type ProjectEventRepoLink = {
  repoId: string
  bindingId: string
  createdAt: number
}

export type LinkProjectEventBindingResult =
  | { ok: true; link: ProjectEventRepoLink }
  | { ok: false; reason: 'repo-already-linked'; bindingId: string }
  | { ok: false; reason: 'binding-already-linked'; repoId: string }
  | { ok: false; reason: 'binding-not-found' }

function linkFromRow(row: SqliteRow): ProjectEventRepoLink {
  return {
    repoId: rowText(row, 'repo_id'),
    bindingId: rowText(row, 'binding_id'),
    createdAt: rowNumber(row, 'created_at')
  }
}

export function getProjectEventRepoLink(
  ctx: ForgeLedgerContext,
  repoId: string
): ProjectEventRepoLink | null {
  const row = ctx.db
    .prepare(
      'SELECT repo_id, binding_id, created_at FROM project_event_repo_links WHERE host_id = ? AND repo_id = ?'
    )
    .get(ctx.hostId, repoId)
  return row ? linkFromRow(row) : null
}

export function getProjectEventRepoLinkByBinding(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectEventRepoLink | null {
  const row = ctx.db
    .prepare(
      'SELECT repo_id, binding_id, created_at FROM project_event_repo_links WHERE host_id = ? AND binding_id = ?'
    )
    .get(ctx.hostId, bindingId)
  return row ? linkFromRow(row) : null
}

/** True when linking this repo to this binding would steal either side from its current partner. */
export function hasProjectEventLinkConflict(
  ctx: ForgeLedgerContext,
  repoId: string,
  bindingId: string | null
): boolean {
  const repoLink = getProjectEventRepoLink(ctx, repoId)
  if (repoLink !== null && repoLink.bindingId !== bindingId) {
    return true
  }
  const bindingLink = bindingId === null ? null : getProjectEventRepoLinkByBinding(ctx, bindingId)
  return bindingLink !== null && bindingLink.repoId !== repoId
}

export function listProjectEventRepoLinks(ctx: ForgeLedgerContext): ProjectEventRepoLink[] {
  return ctx.db
    .prepare(
      'SELECT repo_id, binding_id, created_at FROM project_event_repo_links WHERE host_id = ? ORDER BY repo_id'
    )
    .all(ctx.hostId)
    .map(linkFromRow)
}

export function linkProjectEventBinding(
  ctx: ForgeLedgerContext,
  input: {
    repoId: string
    bindingId: string
    /** Current path resolved by the host, never supplied by a webhook. */
    projectPath?: string
  }
): LinkProjectEventBindingResult {
  return runForgeTransaction(ctx.db, (): LinkProjectEventBindingResult => {
    const existing = getProjectEventRepoLink(ctx, input.repoId)
    if (existing && existing.bindingId !== input.bindingId) {
      return { ok: false, reason: 'repo-already-linked', bindingId: existing.bindingId }
    }
    if (!existing) {
      const binding = ctx.db
        .prepare('SELECT repo_id FROM project_event_repo_links WHERE binding_id = ?')
        .get(input.bindingId)
      if (binding) {
        return { ok: false, reason: 'binding-already-linked', repoId: rowText(binding, 'repo_id') }
      }
      const exists = ctx.db
        .prepare('SELECT 1 AS found FROM project_bindings WHERE binding_id = ?')
        .get(input.bindingId)
      if (!exists) {
        return { ok: false, reason: 'binding-not-found' }
      }
      ctx.db
        .prepare(
          `INSERT INTO project_event_repo_links (host_id, repo_id, binding_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(ctx.hostId, input.repoId, input.bindingId, ctx.now())
    }
    if (input.projectPath !== undefined) {
      ctx.db
        .prepare(
          'UPDATE project_bindings SET project_path = ?, updated_at = ? WHERE binding_id = ?'
        )
        .run(input.projectPath, ctx.now(), input.bindingId)
    }
    const link = getProjectEventRepoLink(ctx, input.repoId)
    if (!link) {
      throw new Error('a linked project event binding should be readable')
    }
    return { ok: true, link }
  })
}

export function removeProjectEventRepoLink(ctx: ForgeLedgerContext, repoId: string): boolean {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare('DELETE FROM project_event_repo_links WHERE host_id = ? AND repo_id = ?')
      .run(ctx.hostId, repoId)
    return result.changes > 0
  })
}

/** Removes the link owned by this binding, so deleting a project cannot leave a dangling repo. */
export function removeProjectEventRepoLinkForBinding(
  ctx: ForgeLedgerContext,
  bindingId: string
): boolean {
  return runForgeTransaction(ctx.db, () => {
    const result = ctx.db
      .prepare('DELETE FROM project_event_repo_links WHERE host_id = ? AND binding_id = ?')
      .run(ctx.hostId, bindingId)
    return result.changes > 0
  })
}
