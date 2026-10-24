import { createHash } from 'node:crypto'
import {
  FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS,
  FORGE_PATCH_REQUEST_MAX_PATHS,
  FORGE_PATCH_REQUEST_MAX_PATH_CHARS,
  type ForgePatchRequestRefusal
} from '../../shared/forge-patch-request'
import { canonicalJson } from './forge-inbox-canonical-json'
import { readForgeConfigState } from './forge-inbox-config'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import {
  FORGE_PATCH_REQUEST_INTERRUPTED,
  hasControlCharacter,
  isBoundedIdentifier,
  patchRequestFromRow,
  readForgePatchRequestById,
  type ForgePatchRequest
} from './forge-inbox-patch-request-record'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import { rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeInstanceScope } from './forge-inbox-types'

export {
  FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS,
  readForgePatchRequest,
  type ForgePatchRequest,
  type ForgePatchRequestState
} from './forge-inbox-patch-request-record'

export {
  FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS,
  FORGE_PATCH_REQUEST_MAX_PATHS,
  FORGE_PATCH_REQUEST_MAX_PATH_CHARS,
  type ForgePatchRequestRefusal
} from '../../shared/forge-patch-request'

/** Bounded transient input: it is canonicalized into a digest and never written to the ledger. */
export type ForgePatchRequestIntent = {
  message: string
  paths: readonly string[]
}

export type ForgePatchRequestClaimInput = {
  scope: ForgeInstanceScope
  /** The authenticated caller; requests from another caller are never addressable. */
  callerKey: string
  operationId: string
  runId: number
  intent: ForgePatchRequestIntent
}

export type ForgePatchRequestClaimResult =
  | { kind: 'claimed'; request: ForgePatchRequest }
  | { kind: 'in-progress'; request: ForgePatchRequest }
  | { kind: 'terminal'; request: ForgePatchRequest }
  | { kind: 'unverifiable'; request: ForgePatchRequest }
  | { kind: 'refused'; reason: ForgePatchRequestRefusal }

type NormalizedIntent = { message: string; paths: string[] }

/** Paths are an unordered set; retries that only reorder or repeat a path are the same intent. */
function normalizeIntent(intent: ForgePatchRequestIntent): NormalizedIntent | null {
  if (typeof intent !== 'object' || intent === null) {
    return null
  }
  const message = intent.message
  if (
    typeof message !== 'string' ||
    message.trim() === '' ||
    message.length > FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS ||
    !Array.isArray(intent.paths) ||
    intent.paths.length > FORGE_PATCH_REQUEST_MAX_PATHS
  ) {
    return null
  }
  const paths = new Set<string>()
  for (const path of intent.paths) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > FORGE_PATCH_REQUEST_MAX_PATH_CHARS ||
      hasControlCharacter(path)
    ) {
      return null
    }
    paths.add(path)
  }
  return { message, paths: [...paths].sort() }
}

function requestDigest(runId: number, intent: NormalizedIntent): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        kind: 'forge-inbox-patch-request',
        runId,
        message: intent.message,
        paths: intent.paths
      })
    )
    .digest('hex')
}

function existingOutcome(request: ForgePatchRequest): ForgePatchRequestClaimResult {
  const kind =
    request.state === 'in_progress'
      ? 'in-progress'
      : request.state === 'unverifiable'
        ? 'unverifiable'
        : 'terminal'
  return { kind, request }
}

/**
 * The only writer of a patch request. Idempotency is checked before eligibility, so a retry
 * replays the original answer and never re-prices against fences that moved under it.
 */
export function claimForgePatchRequest(
  ctx: ForgeLedgerContext,
  input: ForgePatchRequestClaimInput
): ForgePatchRequestClaimResult {
  if (!isBoundedIdentifier(input.callerKey)) {
    return { kind: 'refused', reason: 'invalid-caller' }
  }
  if (!isBoundedIdentifier(input.operationId)) {
    return { kind: 'refused', reason: 'invalid-operation-id' }
  }
  const intent = normalizeIntent(input.intent)
  if (!intent) {
    return { kind: 'refused', reason: 'invalid-intent' }
  }
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) {
    return { kind: 'refused', reason: 'run-not-found' }
  }
  const digest = requestDigest(input.runId, intent)
  return runForgeTransaction(ctx.db, (): ForgePatchRequestClaimResult => {
    const existing = ctx.db
      .prepare(
        `SELECT p.*, i.host_id AS item_host_id, i.instance_id AS item_instance_id
         FROM patch_requests p JOIN items i ON i.id = p.item_id
         WHERE p.caller_key = ? AND p.operation_id = ?`
      )
      .get(input.callerKey, input.operationId)
    if (existing) {
      // A request stored for another owner or explicit instance never exposes its outcome.
      if (
        rowText(existing, 'item_host_id') !== ctx.hostId ||
        (input.scope.instanceId !== undefined &&
          input.scope.instanceId !== rowText(existing, 'item_instance_id'))
      ) {
        return { kind: 'refused', reason: 'run-not-found' }
      }
      const request = patchRequestFromRow(existing)
      return request.requestDigest === digest
        ? existingOutcome(request)
        : { kind: 'refused', reason: 'intent-conflict' }
    }

    const run = ctx.db
      .prepare(
        `SELECT r.id AS run_id, r.state AS run_state, r.generation AS run_generation,
           r.revision AS run_revision, r.policy_generation AS run_policy_generation,
           r.session_id AS run_session_id, r.item_id AS item_id,
           i.host_id AS item_host_id, i.instance_id AS item_instance_id,
           i.project_id AS item_project_id, i.current_revision AS item_current_revision
         FROM runs r JOIN items i ON i.id = r.item_id WHERE r.id = ?`
      )
      .get(input.runId)
    if (!run || rowText(run, 'item_host_id') !== ctx.hostId) {
      return { kind: 'refused', reason: 'run-not-found' }
    }
    const instanceId = rowText(run, 'item_instance_id')
    if (input.scope.instanceId !== undefined && input.scope.instanceId !== instanceId) {
      return { kind: 'refused', reason: 'run-not-found' }
    }
    const state = rowText(run, 'run_state')
    if (state !== 'succeeded' && state !== 'awaiting-approval') {
      return { kind: 'refused', reason: 'run-not-eligible' }
    }
    const sessionId = run.run_session_id
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { kind: 'refused', reason: 'session-not-bound' }
    }
    const itemId = rowNumber(run, 'item_id')
    const revision = rowNumber(run, 'run_revision')
    const policyGeneration = rowNumber(run, 'run_policy_generation')
    if (rowNumber(run, 'item_current_revision') !== revision) {
      return { kind: 'refused', reason: 'revision-stale' }
    }
    if (policyGeneration !== policyGenerationOfItem(ctx, itemId)) {
      return { kind: 'refused', reason: 'policy-stale' }
    }
    const projectId = rowText(run, 'item_project_id')
    const config = readForgeConfigState(ctx)
    const project = config.config.instances
      .find((instance) => instance.id === instanceId)
      ?.projects.find((candidate) => candidate.projectId === projectId)
    if (!project?.enabled) {
      return { kind: 'refused', reason: 'project-unavailable' }
    }

    const now = ctx.now()
    const inserted = ctx.db
      .prepare(
        `INSERT INTO patch_requests (caller_key, operation_id, request_digest, run_id,
           run_generation, session_id, item_id, revision, policy_generation, config_revision,
           invalidation_generation, state, proposal_id, reason_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(
        input.callerKey,
        input.operationId,
        digest,
        input.runId,
        rowNumber(run, 'run_generation'),
        sessionId,
        itemId,
        revision,
        policyGeneration,
        config.revision,
        readForgeProjectInvalidationGeneration(ctx, { instanceId, projectId }),
        now,
        now
      )
    return {
      kind: 'claimed',
      request: readForgePatchRequestById(ctx, rowNumber({ v: inserted.lastInsertRowid }, 'v'))
    }
  })
}

/** A process that dies mid-claim leaves work nobody may resume; the retry reads the coded outcome. */
export function markInterruptedForgePatchRequestsUnverifiable(ctx: ForgeLedgerContext): number {
  return runForgeTransaction(ctx.db, () => {
    const updated = ctx.db
      .prepare(
        `UPDATE patch_requests SET state = 'unverifiable', reason_code = ?,
           updated_at = ?
         WHERE state = 'in_progress'
           AND run_id IN (SELECT r.id FROM runs r JOIN items i ON i.id = r.item_id
             WHERE i.host_id = ?)`
      )
      .run(FORGE_PATCH_REQUEST_INTERRUPTED, ctx.now(), ctx.hostId)
    return Number(updated.changes)
  })
}
