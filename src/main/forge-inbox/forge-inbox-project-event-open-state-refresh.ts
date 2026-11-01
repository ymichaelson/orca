import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { observeProjectEventItemState } from './forge-inbox-project-event-item-state-observation'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import { readForgeConfigState } from './forge-inbox-config'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { rowNumber, rowText } from './forge-inbox-rows'

export type GitlabProjectScope = { host: string; repoPath: string; projectId: number }

/** A decided request, named by its item or by the delivery body an older or unlinked row carries. */
type OpenRow = {
  id: number
  kind: string
  /** A negative iid is a signed project suffix, never an object; only the delivery body names it. */
  iid: number
  project: string
  binding: string | null
}

/**
 * Open requests whose decision has finished: the merge happened after it, so the state the item kept
 * (a verified snapshot from before the merge) is older than what GitLab now says.
 */
const OPEN_DECIDED_ROWS = `
  SELECT i.id, i.kind, i.project_id AS project,
    CASE WHEN i.iid >= 0 THEN i.iid
      ELSE COALESCE(json_extract(CASE WHEN json_valid(w.body) THEN w.body ELSE '{}' END,
        '$.object_attributes.iid'), i.iid) END AS iid,
    (SELECT l.binding_id FROM project_event_repo_links l
       JOIN project_bindings b ON b.binding_id = l.binding_id
       WHERE l.host_id = i.host_id AND b.gitlab_path = i.project_id LIMIT 1) AS link,
    w.binding_id AS delivery
  FROM items i
  JOIN project_event_decisions d ON d.host_id = i.host_id
  JOIN webhook_deliveries w ON w.id = d.delivery_id AND w.host_id = d.host_id
  WHERE i.host_id = ? AND i.kind IN ('merge_request', 'issue')
    AND i.state IN ('opened', 'locked')
    AND d.action_state IN ('done', 'awaiting-event', 'blocked', 'cancelled')
    AND (d.item_id = i.id
      OR json_extract(CASE WHEN json_valid(w.body) THEN w.body ELSE '{}' END,
        '$.object_attributes.iid') = i.iid)
  -- One row per item and delivery: an item refreshed from one decision need not be read again.
  GROUP BY i.id, d.delivery_id`

/**
 * An open request a person merged elsewhere would otherwise stay "not merged": the hook that says so
 * arrived, but this item's head is a verified snapshot from before the merge that outranks it.
 */
export async function refreshOpenItemStatesOnOpen(
  ledger: ForgeInboxLedger,
  deps: {
    signal?: AbortSignal
    readerFor?: (input: GitlabProjectScope) => GitlabApiReader
    onError?: (error: unknown) => void
  } = {}
): Promise<number> {
  const { signal } = deps
  let refreshed = 0
  const ctx = ledger.ledgerContext()
  try {
    const revision = readForgeConfigState(ctx).revision
    const rows = openRows(ctx, ctx.hostId)
    for (const row of rows) {
      if (signal?.aborted) {
        return refreshed
      }
      if ((row.kind !== 'merge_request' && row.kind !== 'issue') || row.binding === null) {
        continue
      }
      const binding = ctx.db
        .prepare(
          'SELECT gitlab_host, project_path, gitlab_project_id FROM project_bindings WHERE binding_id = ?'
        )
        .get(row.binding)
      const target = bindingTarget(binding)
      if (target === null) {
        continue
      }
      const reader = deps.readerFor === undefined ? undefined : deps.readerFor(target)
      const state = await observeProjectEventItemState(
        ctx,
        {
          ...target,
          projectIdText: row.project,
          bindingId: row.binding,
          ...(reader === undefined ? {} : { reader })
        },
        row.id,
        row.iid,
        signal === undefined ? {} : { signal }
      )
      if (state !== null) {
        refreshed += 1
      }
      // glab retires a failed API credential, which a re-read must not do behind the user's back.
      if (readForgeConfigState(ctx).revision !== revision) {
        return refreshed
      }
    }
  } catch (error) {
    // A failed re-read keeps the reported state; the next open tries again.
    if (deps.onError) {
      deps.onError(error)
    } else {
      console.warn('[forge-inbox] project item state refresh failed', forgeErrorLabel(error))
    }
  }
  return refreshed
}

function bindingTarget(binding: SqliteRow | undefined): GitlabProjectScope | null {
  if (binding === undefined) {
    return null
  }
  const host = rowText(binding, 'gitlab_host')
  const projectId = rowNumber(binding, 'gitlab_project_id')
  if (!host || !Number.isSafeInteger(projectId) || projectId <= 0) {
    return null
  }
  return { host, repoPath: rowText(binding, 'project_path'), projectId }
}

/** The project's link names the binding a re-read may speak for; the delivery's own is the fallback. */
function openRows(ctx: ReturnType<ForgeInboxLedger['ledgerContext']>, hostId: string): OpenRow[] {
  return ctx.db
    .prepare(OPEN_DECIDED_ROWS)
    .all(hostId)
    .map((row) => {
      const link = row.link === null || row.link === undefined ? '' : String(row.link)
      const delivery =
        row.delivery === null || row.delivery === undefined ? '' : String(row.delivery)
      return {
        id: rowNumber(row, 'id'),
        kind: String(row.kind),
        iid: rowNumber(row, 'iid'),
        project: String(row.project),
        binding: link !== '' ? link : delivery !== '' ? delivery : null
      }
    })
}
