import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  createGlabApiRequester,
  createGlabApiTextRequester,
  type GlabApiExec
} from './forge-inbox-glab-api-requester'
import {
  createGitlabApiReaderWithRequesters,
  type GitlabApiReader,
  type GitlabApiRequesters
} from './forge-inbox-gitlab-api-client'
import type { GitlabApiErrorCode } from './forge-inbox-gitlab-api-request'
import { readForgeItemWatermark } from './forge-inbox-item-watermark'
import { BINDING_INSTANCE_PREFIX } from './forge-inbox-project-binding'
import { ingestForgeObservation } from './forge-inbox-observation'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action'
import {
  observeSnapshot,
  type SnapshotResult
} from './forge-inbox-project-event-observation-snapshot'
import { projectEventSubject } from './forge-inbox-project-event-subject'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import { isRecord, rowNumber, rowText } from './forge-inbox-rows'
import { isForgeAnalysisItemKind, type ForgeItemKind } from './forge-inbox-types'

export type ObservedFailureCode =
  | GitlabApiErrorCode
  | 'aborted'
  | 'binding-missing'
  | 'binding-mismatch'
  | 'context-unavailable'
  | 'dirty-observation'
  | 'head-moved'
  | 'invalid-input'
  | 'item-identity-missing'
  | 'stale-config'

export type ProjectEventHeadObservation =
  | {
      ok: true
      itemId: number
      revision: number
      versionToken: string
      complete: boolean
      newRevision: boolean
      kind: ForgeItemKind
      iid: number
      sha: string | null
      title: string | null
      state: string | null
    }
  | { ok: false; code: ObservedFailureCode }

const fail = (code: ObservedFailureCode): ProjectEventHeadObservation => ({ ok: false, code })

// Why: one re-read per attempt means a head that lands during notes/diffs gets exactly one retry.
const MAX_SNAPSHOT_ATTEMPTS = 2

export function projectScopedRequesters(
  host: string,
  repoPath: string,
  projectId: number,
  exec: GlabApiExec | undefined,
  signal: AbortSignal | undefined
): GitlabApiRequesters {
  const config = { hostname: host, repoPath, exec, signal }
  const projectRequester = createGlabApiRequester(config)
  const projectTextRequester = createGlabApiTextRequester(config)
  const instanceRequester = createGlabApiRequester(config)
  const prefix = `projects/${encodeURIComponent(String(projectId))}`
  return {
    requester: { get: (path, query) => projectRequester.get(`${prefix}${path}`, query) },
    textRequester: {
      getText: (path, query) => projectTextRequester.getText(`${prefix}${path}`, query)
    },
    // Why: instance endpoints (e.g. /user) must not be scoped under projects/<id>.
    instanceRequester
  }
}

function projectScopedReader(
  host: string,
  repoPath: string,
  projectId: number,
  exec: GlabApiExec | undefined,
  signal: AbortSignal | undefined
): GitlabApiReader {
  return createGitlabApiReaderWithRequesters(
    projectScopedRequesters(host, repoPath, projectId, exec, signal),
    { baseUrl: `https://${host}`, projectId: String(projectId), expectedConfigRevision: 0 }
  )
}

function persistedPayload(raw: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(raw)
    return isRecord(payload) ? payload : {}
  } catch {
    return {}
  }
}

/**
 * Reads the authoritative head from GitLab and records it as the item's newest revision. Nothing is
 * written unless every bounded read succeeds and a final re-read proves the head did not move.
 */
export async function observeProjectEventBindingHead(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  deps: { exec?: GlabApiExec; signal?: AbortSignal } = {}
): Promise<ProjectEventHeadObservation> {
  if (deps.signal?.aborted) {
    return fail('aborted')
  }
  const delivery = ctx.db
    .prepare(
      `SELECT binding_id, event_kind, project_id, body FROM webhook_deliveries
       WHERE id = ? AND host_id = ?`
    )
    .get(claim.deliveryId, ctx.hostId)
  if (!delivery) {
    return fail('invalid-input')
  }
  if (rowText(delivery, 'binding_id') !== claim.bindingId) {
    return fail('binding-mismatch')
  }
  const binding = ctx.db
    .prepare(
      `SELECT project_path, gitlab_host, gitlab_path, gitlab_project_id
       FROM project_bindings WHERE binding_id = ?`
    )
    .get(claim.bindingId)
  if (!binding) {
    return fail('binding-missing')
  }
  const host = rowText(binding, 'gitlab_host')
  const repoPath = rowText(binding, 'project_path')
  const gitlabPath = rowText(binding, 'gitlab_path')
  const projectId = rowNumber(binding, 'gitlab_project_id')
  if (!host || !repoPath || !gitlabPath || !Number.isSafeInteger(projectId) || projectId <= 0) {
    return fail('binding-missing')
  }
  const deliveryProjectId = rowText(delivery, 'project_id')
  if (gitlabPath !== deliveryProjectId) {
    return fail('binding-mismatch')
  }
  const subject = projectEventSubject(delivery.body, projectId)
  if (subject === null) {
    return fail('item-identity-missing')
  }
  const { kind, iid } = subject
  // A project item is the event itself: there is no GitLab object behind it to read back.
  if (!isForgeAnalysisItemKind(kind)) {
    return fail('context-unavailable')
  }

  const itemKey = {
    instanceId: `${BINDING_INSTANCE_PREFIX}${host}`,
    projectId: deliveryProjectId,
    kind,
    iid
  }
  const expectedConfigRevision = readForgeConfigState(ctx).revision
  const expectedInvalidationGeneration = readForgeProjectInvalidationGeneration(ctx, itemKey)
  // Why: captured before the network reads so a head that lands during them is refused, not written.
  const expectedHeadOrder = readForgeItemWatermark(ctx, itemKey)?.headOrder ?? 0
  const reader = projectScopedReader(host, repoPath, projectId, deps.exec, deps.signal)

  let snapshot: Extract<SnapshotResult, { ok: true; stable: true }> | null = null
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS && snapshot === null; attempt++) {
    const result = await observeSnapshot(reader, kind, iid)
    if (!result.ok) {
      return deps.signal?.aborted ? fail('aborted') : fail(result.code)
    }
    if (result.stable) {
      snapshot = result
    }
  }
  if (snapshot === null) {
    return fail('head-moved')
  }
  if (deps.signal?.aborted) {
    return fail('aborted')
  }

  const payload = {
    source: 'observed',
    kind,
    iid,
    sha: snapshot.sha,
    complete: snapshot.digest.completeness.complete
  }
  const result = ingestForgeObservation(
    ctx,
    {
      hostId: ctx.hostId,
      ...itemKey,
      dedupeKey: `obs:${claim.token}`,
      eventKind: rowText(delivery, 'event_kind'),
      versionToken: snapshot.digest.versionToken,
      payload,
      title: snapshot.title,
      itemState: snapshot.itemState
    },
    expectedConfigRevision,
    expectedInvalidationGeneration,
    expectedHeadOrder
  )
  if (!result.ok) {
    return fail(result.reason)
  }
  if (!result.duplicate) {
    return {
      ok: true,
      itemId: result.itemId,
      revision: result.revision,
      versionToken: snapshot.digest.versionToken,
      complete: snapshot.digest.completeness.complete,
      newRevision: result.newRevision,
      kind,
      iid,
      sha: snapshot.sha,
      title: snapshot.title,
      state: snapshot.itemState
    }
  }
  // Why: a retried claim must report the revision and token it actually persisted, not the new read.
  const event = ctx.db
    .prepare(
      `SELECT e.item_id, e.revision, e.version_token, e.payload_json, i.title, i.state
       FROM events e JOIN items i ON i.id = e.item_id WHERE e.id = ?`
    )
    .get(result.eventId)
  if (!event) {
    throw new Error('an observed event should be readable after ingest')
  }
  const persisted = persistedPayload(rowText(event, 'payload_json'))
  return {
    ok: true,
    itemId: rowNumber(event, 'item_id'),
    revision: rowNumber(event, 'revision'),
    versionToken: rowText(event, 'version_token'),
    complete: persisted.complete === true,
    newRevision: false,
    kind,
    iid,
    sha: typeof persisted.sha === 'string' ? persisted.sha : null,
    title: rowText(event, 'title'),
    state: rowText(event, 'state')
  }
}
