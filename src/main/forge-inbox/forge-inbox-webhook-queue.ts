import type { ForgeLedgerContext } from './forge-inbox-context'
import { readForgeConfigState } from './forge-inbox-config'
import { runForgeTransaction } from './forge-inbox-database'
import { rowNumber, rowText } from './forge-inbox-rows'
import { invalidateForgeProjectInTransaction } from './forge-inbox-project-invalidation'

export const FORGE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024
export const FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS = {
  maxPending: 1000,
  maxQueuedBytes: 16 * 1024 * 1024
}
const MAX_LIST_LIMIT = 100

export type ForgeWebhookQueueLimits = typeof FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS

export type ForgeWebhookAdmission = {
  instanceId: string
  projectId: string
  /** The revision observed when the delivery authenticated; admission fails if it moved. */
  expectedConfigRevision: number
  eventKind: string
  dedupeKey: string
  correlation: { eventUuid: string | null; configUuid: string | null }
  body: Buffer
}

export type ForgeWebhookAdmissionResult =
  | { ok: true; duplicate: boolean; deliveryId: number; configRevision: number }
  | {
      ok: false
      reason:
        | 'stale-config'
        | 'unknown-project'
        | 'project-disabled'
        | 'queue-full'
        | 'body-too-large'
    }

export type ForgeWebhookDelivery = {
  id: number
  instanceId: string
  projectId: string
  eventKind: string
  dedupeKey: string
  eventUuid: string | null
  configUuid: string | null
  configRevision: number
  admittedAt: number
  state: 'pending'
  body: Buffer
}

export type ForgeWebhookQueueStatus = ForgeWebhookQueueLimits & {
  pending: number
  queuedBytes: number
}

export function admitForgeWebhookDelivery(
  ctx: ForgeLedgerContext,
  limits: ForgeWebhookQueueLimits,
  input: ForgeWebhookAdmission
): ForgeWebhookAdmissionResult {
  if (input.body.length > FORGE_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, reason: 'body-too-large' }
  }
  return runForgeTransaction(ctx.db, (): ForgeWebhookAdmissionResult => {
    const state = readForgeConfigState(ctx)
    if (state.revision !== input.expectedConfigRevision) {
      return { ok: false, reason: 'stale-config' }
    }
    const project = state.config.instances
      .find((instance) => instance.id === input.instanceId)
      ?.projects.find((candidate) => candidate.projectId === input.projectId)
    if (!project) {
      return { ok: false, reason: 'unknown-project' }
    }
    if (!project.enabled) {
      return { ok: false, reason: 'project-disabled' }
    }
    const existing = ctx.db
      .prepare(
        'SELECT id, config_revision FROM webhook_deliveries WHERE host_id = ? AND instance_id = ? AND dedupe_key = ?'
      )
      .get(ctx.hostId, input.instanceId, input.dedupeKey)
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        deliveryId: rowNumber(existing, 'id'),
        configRevision: rowNumber(existing, 'config_revision')
      }
    }
    const status = readQueueStatus(ctx, limits)
    if (
      status.pending + 1 > limits.maxPending ||
      status.queuedBytes + input.body.length > limits.maxQueuedBytes
    ) {
      return { ok: false, reason: 'queue-full' }
    }
    const inserted = ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
           event_uuid, config_uuid, config_revision, admitted_at, state, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        ctx.hostId,
        input.instanceId,
        input.projectId,
        input.dedupeKey,
        input.eventKind,
        input.correlation.eventUuid,
        input.correlation.configUuid,
        state.revision,
        ctx.now(),
        input.body
      )
    invalidateForgeProjectInTransaction(ctx, input)
    return {
      ok: true,
      duplicate: false,
      deliveryId: rowNumber({ v: inserted.lastInsertRowid }, 'v'),
      configRevision: state.revision
    }
  })
}

function readQueueStatus(
  ctx: ForgeLedgerContext,
  limits: ForgeWebhookQueueLimits
): ForgeWebhookQueueStatus {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS pending, COALESCE(SUM(LENGTH(body)), 0) AS bytes
       FROM webhook_deliveries WHERE host_id = ? AND state IN ('pending', 'needs-auth')`
    )
    .get(ctx.hostId)
  return {
    ...limits,
    pending: row ? rowNumber(row, 'pending') : 0,
    queuedBytes: row ? rowNumber(row, 'bytes') : 0
  }
}

export function getForgeWebhookQueueStatus(
  ctx: ForgeLedgerContext,
  limits: ForgeWebhookQueueLimits
): ForgeWebhookQueueStatus {
  return readQueueStatus(ctx, limits)
}

/** Host-private: returns raw bodies for the trusted worker; never expose over RPC. */
export function listForgeWebhookDeliveries(
  ctx: ForgeLedgerContext,
  query: { limit: number }
): ForgeWebhookDelivery[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), MAX_LIST_LIMIT)
  return ctx.db
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE host_id = ? AND state = 'pending' ORDER BY id LIMIT ?`
    )
    .all(ctx.hostId, limit)
    .map((row) => {
      if (!(row.body instanceof Uint8Array)) {
        throw new Error('forge inbox webhook body is not binary')
      }
      return {
        id: rowNumber(row, 'id'),
        instanceId: rowText(row, 'instance_id'),
        projectId: rowText(row, 'project_id'),
        eventKind: rowText(row, 'event_kind'),
        dedupeKey: rowText(row, 'dedupe_key'),
        eventUuid: row.event_uuid === null ? null : rowText(row, 'event_uuid'),
        configUuid: row.config_uuid === null ? null : rowText(row, 'config_uuid'),
        configRevision: rowNumber(row, 'config_revision'),
        admittedAt: rowNumber(row, 'admitted_at'),
        state: 'pending',
        body: Buffer.from(row.body)
      }
    })
}
