import type { SqliteRow } from '../sqlite/sqlite-statement'
import {
  FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS,
  hasControlCharacter,
  type ForgePatchRequestState
} from '../../shared/forge-patch-request'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeInstanceScope } from './forge-inbox-types'

export {
  FORGE_PATCH_REQUEST_INTERRUPTED,
  FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS,
  type ForgePatchRequestInterruptedReason,
  type ForgePatchRequestState
} from '../../shared/forge-patch-request'

/** Host-private request identity and the fences captured when it was claimed; no prompt is stored. */
export type ForgePatchRequest = {
  id: number
  callerKey: string
  operationId: string
  requestDigest: string
  runId: number
  runGeneration: number
  sessionId: string
  itemId: number
  revision: number
  policyGeneration: number
  configRevision: number
  invalidationGeneration: number
  state: ForgePatchRequestState
  proposalId: number | null
  reasonCode: string | null
  createdAt: number
  updatedAt: number
}

export { hasControlCharacter }

export function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS &&
    !hasControlCharacter(value)
  )
}

function requestState(value: string): ForgePatchRequestState {
  switch (value) {
    case 'in_progress':
    case 'succeeded':
    case 'failed':
    case 'unverifiable':
      return value
    default:
      throw new Error(`forge inbox patch request state ${value} is unknown`)
  }
}

export function patchRequestFromRow(row: SqliteRow): ForgePatchRequest {
  return {
    id: rowNumber(row, 'id'),
    callerKey: rowText(row, 'caller_key'),
    operationId: rowText(row, 'operation_id'),
    requestDigest: rowText(row, 'request_digest'),
    runId: rowNumber(row, 'run_id'),
    runGeneration: rowNumber(row, 'run_generation'),
    // Claims always bind a durable session; the schema rejects a null.
    sessionId: rowText(row, 'session_id'),
    itemId: rowNumber(row, 'item_id'),
    revision: rowNumber(row, 'revision'),
    policyGeneration: rowNumber(row, 'policy_generation'),
    configRevision: rowNumber(row, 'config_revision'),
    invalidationGeneration: rowNumber(row, 'invalidation_generation'),
    state: requestState(rowText(row, 'state')),
    proposalId: row.proposal_id === null ? null : rowNumber(row, 'proposal_id'),
    reasonCode: row.reason_code === null ? null : rowText(row, 'reason_code'),
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at')
  }
}

export function readForgePatchRequestById(ctx: ForgeLedgerContext, id: number): ForgePatchRequest {
  const row = ctx.db.prepare('SELECT * FROM patch_requests WHERE id = ?').get(id)
  if (!row) {
    throw new Error('forge inbox patch request vanished inside its own transaction')
  }
  return patchRequestFromRow(row)
}

export function readForgePatchRequest(
  ctx: ForgeLedgerContext,
  requestId: number,
  callerKey: string,
  scope: ForgeInstanceScope
): ForgePatchRequest | null {
  if (!isBoundedIdentifier(callerKey) || !Number.isSafeInteger(requestId) || requestId < 1) {
    return null
  }
  const row = ctx.db
    .prepare(
      `SELECT p.* FROM patch_requests p JOIN items i ON i.id = p.item_id
       WHERE p.id = ? AND p.caller_key = ? AND i.host_id = ?
         AND (? IS NULL OR i.instance_id = ?)`
    )
    .get(requestId, callerKey, ctx.hostId, scope.instanceId ?? null, scope.instanceId ?? null)
  return row ? patchRequestFromRow(row) : null
}
