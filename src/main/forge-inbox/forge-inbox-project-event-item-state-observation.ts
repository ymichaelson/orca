import type { ForgeLedgerContext } from './forge-inbox-context'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GlabApiExec } from './forge-inbox-glab-api-requester'
import { projectScopedReader } from './forge-inbox-project-event-observation'
import type { GitlabProjectScope } from './forge-inbox-project-event-open-state-refresh'
import { ingestForgeObservation } from './forge-inbox-observation'
import { readForgeConfigState } from './forge-inbox-config'
import { readForgeItemWatermark } from './forge-inbox-item-watermark'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import { rowNumber } from './forge-inbox-rows'
import type { ForgeItemKind } from './forge-inbox-types'

/** The subject of a state re-read: the object's iid, and the ledger key the item is stored under. */
export type ProjectEventItemStateKey = GitlabProjectScope & {
  projectIdText: string
  bindingId: string
  reader?: GitlabApiReader
}

type KeyedItem = { kind: ForgeItemKind; iid: number; itemIdSuffix: number | null }

/** The item row a state re-read is about, as the ledger keyed it. */
function keyedItem(ctx: ForgeLedgerContext, itemId: number): KeyedItem | null {
  const row = ctx.db
    .prepare('SELECT kind, iid, instance_id FROM items WHERE id = ? AND host_id = ?')
    .get(itemId, ctx.hostId)
  if (!row || (row.kind !== 'issue' && row.kind !== 'merge_request')) {
    return null
  }
  // A negative iid is a signed project suffix; a positive one is the object itself, even when the
  // delivery named the same number as a suffix.
  const iid = rowNumber(row, 'iid')
  return { kind: row.kind, iid, itemIdSuffix: iid < 0 ? iid : null }
}

/**
 * Re-reads one subject's state from GitLab and records it as a new revision, without a delivery:
 * a request merged after its decision would otherwise keep the state it had before the merge.
 */
export async function observeProjectEventItemState(
  ctx: ForgeLedgerContext,
  key: ProjectEventItemStateKey,
  itemId: number,
  /** The iid the delivery was about; the item's own may be a project suffix instead. */
  subjectIid: number,
  deps: { exec?: GlabApiExec; signal?: AbortSignal } = {}
): Promise<string | null> {
  const row = keyedItem(ctx, itemId)
  if (deps.signal?.aborted || row === null || subjectIid < 0) {
    return null
  }
  const binding = ctx.db
    .prepare('SELECT gitlab_host FROM project_bindings WHERE binding_id = ?')
    .get(key.bindingId)
  const itemKey = {
    instanceId: `${BINDING_INSTANCE_PREFIX}${binding === undefined ? '' : String(binding.gitlab_host)}`,
    projectId: key.projectIdText,
    kind: row.kind,
    iid: row.itemIdSuffix ?? subjectIid
  }
  const expectedConfigRevision = readForgeConfigState(ctx).revision
  const expectedInvalidationGeneration = readForgeProjectInvalidationGeneration(ctx, itemKey)
  const expectedHeadOrder = readForgeItemWatermark(ctx, itemKey)?.headOrder ?? 0
  const reader =
    key.reader ?? projectScopedReader(key.host, key.repoPath, key.projectId, deps.exec, deps.signal)
  const read =
    row.kind === 'issue'
      ? await reader.getIssue(subjectIid)
      : await reader.getMergeRequest(subjectIid)
  if (!read.ok) {
    return null
  }
  const result = ingestForgeObservation(
    ctx,
    {
      hostId: ctx.hostId,
      ...itemKey,
      ...(row.itemIdSuffix === null ? {} : { itemIdSuffix: row.itemIdSuffix }),
      dedupeKey: `state:${key.bindingId}:${subjectIid}:${ctx.now()}`,
      eventKind: 'state',
      versionToken: `state:${row.kind}:${subjectIid}:${read.data.state}`,
      payload: { source: 'observed', kind: row.kind, iid: subjectIid, state: read.data.state },
      title: read.data.title,
      itemState: read.data.state
    },
    expectedConfigRevision,
    expectedInvalidationGeneration,
    expectedHeadOrder
  )
  return result.ok ? read.data.state : null
}
