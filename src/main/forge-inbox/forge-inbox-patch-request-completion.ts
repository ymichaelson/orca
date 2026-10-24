import {
  FORGE_PATCH_REQUEST_FAILURE_REASONS,
  FORGE_PATCH_REQUEST_UNVERIFIABLE_REASONS,
  type ForgePatchRequestFailureReason,
  type ForgePatchRequestUnverifiableReason
} from '../../shared/forge-patch-request'
import { readForgeConfigState } from './forge-inbox-config'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { hashForgePatchDraft, parseForgePatchDraft } from './forge-inbox-patch-draft'
import {
  readForgePatchRequest,
  type ForgePatchRequest,
  type ForgePatchRequestState
} from './forge-inbox-patch-requests'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { appendForgeProposalInTransaction, readForgeProposal } from './forge-inbox-proposals'
import { isRecord, rowNumber, rowText } from './forge-inbox-rows'
import { readForgeRun } from './forge-inbox-runs'
import { readForgeProjectInvalidationGeneration } from './forge-inbox-project-invalidation'
import type { ForgeInstanceScope, ForgeProposal } from './forge-inbox-types'

export {
  FORGE_PATCH_REQUEST_FAILURE_REASONS,
  FORGE_PATCH_REQUEST_UNVERIFIABLE_REASONS,
  type ForgePatchRequestFailureReason,
  type ForgePatchRequestUnverifiableReason
} from '../../shared/forge-patch-request'

/** A producer's coded result; arbitrary error text is never accepted or persisted. */
export type ForgePatchRequestOutcome =
  | { kind: 'success'; draft: unknown; expectedDraftHash: string }
  | { kind: 'failed'; reason: ForgePatchRequestFailureReason }
  | { kind: 'unverifiable'; reason: ForgePatchRequestUnverifiableReason }

export type ForgePatchRequestFinishInput = {
  scope: ForgeInstanceScope
  /** The authenticated caller; a mismatch is indistinguishable from a missing request. */
  callerKey: string
  requestId: number
  /** Digest of the claimed intent, so a finish cannot address another intent's request. */
  expectedRequestDigest: string
  outcome: ForgePatchRequestOutcome
}

export type ForgePatchRequestFinishResult =
  | { kind: 'completed'; request: ForgePatchRequest; proposal: ForgeProposal | null }
  | { kind: 'refused'; reason: 'not-found' | 'invalid-input' | 'request-digest-mismatch' }

const DIGEST = /^[0-9a-f]{64}$/

function isFailureReason(value: unknown): value is ForgePatchRequestFailureReason {
  return (
    typeof value === 'string' &&
    FORGE_PATCH_REQUEST_FAILURE_REASONS.some((reason) => reason === value)
  )
}

function isUnverifiableReason(value: unknown): value is ForgePatchRequestUnverifiableReason {
  return (
    typeof value === 'string' &&
    FORGE_PATCH_REQUEST_UNVERIFIABLE_REASONS.some((reason) => reason === value)
  )
}

type ValidatedOutcome =
  | { kind: 'success'; draft: unknown; expectedDraftHash: string }
  | { kind: 'failed'; reason: ForgePatchRequestFailureReason }
  | { kind: 'unverifiable'; reason: ForgePatchRequestUnverifiableReason }

function validateOutcome(value: unknown): ValidatedOutcome | null {
  if (!isRecord(value)) {
    return null
  }
  switch (value.kind) {
    case 'success':
      return typeof value.expectedDraftHash === 'string'
        ? { kind: 'success', draft: value.draft, expectedDraftHash: value.expectedDraftHash }
        : null
    case 'failed':
      return isFailureReason(value.reason) ? { kind: 'failed', reason: value.reason } : null
    case 'unverifiable':
      return isUnverifiableReason(value.reason)
        ? { kind: 'unverifiable', reason: value.reason }
        : null
    default:
      return null
  }
}

function proposalOfRequest(
  ctx: ForgeLedgerContext,
  request: ForgePatchRequest
): ForgeProposal | null {
  return request.proposalId === null ? null : readForgeProposal(ctx, request.proposalId)
}

function settleRequest(
  ctx: ForgeLedgerContext,
  request: ForgePatchRequest,
  state: Extract<ForgePatchRequestState, 'failed' | 'unverifiable'>,
  reasonCode: string
): ForgePatchRequestFinishResult {
  const updatedAt = ctx.now()
  const updated = ctx.db
    .prepare(
      `UPDATE patch_requests SET state = ?, reason_code = ?, updated_at = ?
       WHERE id = ? AND state = 'in_progress'`
    )
    .run(state, reasonCode, updatedAt, request.id)
  if (updated.changes !== 1) {
    throw new Error('forge inbox patch request changed inside its completion transaction')
  }
  return {
    kind: 'completed',
    request: { ...request, state, reasonCode, updatedAt },
    proposal: null
  }
}

export type ForgePatchRequestFenceResult =
  | { ok: true; item: { instanceId: string; projectId: string } }
  | { ok: false; reason: ForgePatchRequestFailureReason }

/** Re-proves every fence captured at claim time against the current database rows. */
export function verifyForgePatchRequestFences(
  ctx: ForgeLedgerContext,
  request: ForgePatchRequest
): ForgePatchRequestFenceResult {
  const run = readForgeRun(ctx, request.runId)
  if (!run || run.itemId !== request.itemId) {
    return { ok: false, reason: 'run-mismatch' }
  }
  if (run.sessionId !== request.sessionId) {
    return { ok: false, reason: 'session-mismatch' }
  }
  if (run.generation !== request.runGeneration || run.revision !== request.revision) {
    return { ok: false, reason: 'run-mismatch' }
  }
  if (run.policyGeneration !== request.policyGeneration) {
    return { ok: false, reason: 'policy-stale' }
  }
  if (run.state !== 'succeeded' && run.state !== 'awaiting-approval') {
    return { ok: false, reason: 'run-not-eligible' }
  }
  const item = ctx.db
    .prepare(
      'SELECT host_id, instance_id, project_id, kind, current_revision FROM items WHERE id = ?'
    )
    .get(request.itemId)
  if (!item || rowText(item, 'host_id') !== ctx.hostId) {
    return { ok: false, reason: 'run-mismatch' }
  }
  if (rowNumber(item, 'current_revision') !== request.revision) {
    return { ok: false, reason: 'revision-stale' }
  }
  if (rowText(item, 'kind') !== 'merge_request') {
    return { ok: false, reason: 'item-not-merge-request' }
  }
  const instanceId = rowText(item, 'instance_id')
  const projectId = rowText(item, 'project_id')
  const state = readForgeConfigState(ctx)
  const project = state.config.instances
    .find((instance) => instance.id === instanceId)
    ?.projects.find((candidate) => candidate.projectId === projectId)
  if (!project?.enabled) {
    return { ok: false, reason: 'project-unavailable' }
  }
  if (state.revision !== request.configRevision) {
    return { ok: false, reason: 'config-stale' }
  }
  if (policyGenerationOfItem(ctx, request.itemId) !== request.policyGeneration) {
    return { ok: false, reason: 'policy-stale' }
  }
  if (
    readForgeProjectInvalidationGeneration(ctx, { instanceId, projectId }) !==
    request.invalidationGeneration
  ) {
    return { ok: false, reason: 'invalidation-stale' }
  }
  return { ok: true, item: { instanceId, projectId } }
}

/** Ledger-facing fence check: the item identity is not part of this answer. */
export function checkForgePatchRequestFences(
  ctx: ForgeLedgerContext,
  request: ForgePatchRequest
): { ok: true } | { ok: false; reason: ForgePatchRequestFailureReason } {
  const fences = verifyForgePatchRequestFences(ctx, request)
  return fences.ok ? { ok: true } : fences
}

/** Only strict patch manifests are replaced; comments, pushes and lookalike bodies stay live. */
function supersedeOlderPendingPatches(
  ctx: ForgeLedgerContext,
  itemId: number,
  keepId: number
): void {
  const rows = ctx.db
    .prepare(
      `SELECT id, body_json FROM proposals
       WHERE item_id = ? AND status = 'pending' AND id <> ? ORDER BY id`
    )
    .all(itemId, keepId)
  const now = ctx.now()
  for (const row of rows) {
    let body: unknown
    try {
      body = JSON.parse(rowText(row, 'body_json'))
    } catch {
      continue
    }
    if (!parseForgePatchDraft(body)) {
      continue
    }
    const id = rowNumber(row, 'id')
    const updated = ctx.db
      .prepare(
        "UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(now, id)
    if (updated.changes === 1) {
      recordForgeChange(ctx, itemId, 'proposal', id, 'stale')
    }
  }
}

/**
 * Completes a claimed request exactly once. The draft's branch/base are only durable claims: this
 * transaction cannot prove the remote branch still matches, so the host producer reads the
 * authenticated source identity immediately before and after preparing it.
 */
export function finishForgePatchRequest(
  ctx: ForgeLedgerContext,
  input: ForgePatchRequestFinishInput
): ForgePatchRequestFinishResult {
  return runForgeTransaction(ctx.db, (): ForgePatchRequestFinishResult => {
    const request = readForgePatchRequest(ctx, input.requestId, input.callerKey, input.scope)
    if (!request) {
      return { kind: 'refused', reason: 'not-found' }
    }
    // A terminal answer replays even for a changed retry, and writes nothing.
    if (request.state !== 'in_progress') {
      return { kind: 'completed', request, proposal: proposalOfRequest(ctx, request) }
    }
    if (
      typeof input.expectedRequestDigest !== 'string' ||
      !DIGEST.test(input.expectedRequestDigest)
    ) {
      return { kind: 'refused', reason: 'invalid-input' }
    }
    if (input.expectedRequestDigest !== request.requestDigest) {
      return { kind: 'refused', reason: 'request-digest-mismatch' }
    }
    const outcome = validateOutcome(input.outcome)
    if (!outcome) {
      return { kind: 'refused', reason: 'invalid-input' }
    }
    if (outcome.kind === 'failed') {
      return settleRequest(ctx, request, 'failed', outcome.reason)
    }
    if (outcome.kind === 'unverifiable') {
      return settleRequest(ctx, request, 'unverifiable', outcome.reason)
    }

    const fences = verifyForgePatchRequestFences(ctx, request)
    if (!fences.ok) {
      return settleRequest(ctx, request, 'failed', fences.reason)
    }
    const draft = parseForgePatchDraft(outcome.draft)
    if (!draft) {
      return settleRequest(ctx, request, 'failed', 'draft-invalid')
    }
    if (!DIGEST.test(outcome.expectedDraftHash)) {
      return settleRequest(ctx, request, 'failed', 'draft-hash-invalid')
    }
    if (
      draft.target.instanceId !== fences.item.instanceId ||
      draft.target.projectId !== fences.item.projectId
    ) {
      return settleRequest(ctx, request, 'failed', 'target-mismatch')
    }
    if (hashForgePatchDraft(draft) !== outcome.expectedDraftHash) {
      return settleRequest(ctx, request, 'failed', 'draft-hash-mismatch')
    }

    const proposal = appendForgeProposalInTransaction(ctx, {
      runId: request.runId,
      itemId: request.itemId,
      revision: request.revision,
      policyGeneration: request.policyGeneration,
      status: 'pending',
      body: draft
    })
    supersedeOlderPendingPatches(ctx, request.itemId, proposal.id)
    const updatedAt = ctx.now()
    const updated = ctx.db
      .prepare(
        `UPDATE patch_requests SET state = 'succeeded', proposal_id = ?, reason_code = NULL,
           updated_at = ? WHERE id = ? AND state = 'in_progress'`
      )
      .run(proposal.id, updatedAt, request.id)
    if (updated.changes !== 1) {
      throw new Error('forge inbox patch request changed inside its completion transaction')
    }
    return {
      kind: 'completed',
      request: {
        ...request,
        state: 'succeeded',
        proposalId: proposal.id,
        reasonCode: null,
        updatedAt
      },
      proposal
    }
  })
}
