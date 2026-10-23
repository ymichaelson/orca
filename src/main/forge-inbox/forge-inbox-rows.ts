import type { SqliteRow } from '../sqlite/sqlite-statement'
import {
  FORGE_ITEM_KINDS,
  FORGE_RUN_STATES,
  type ForgeAnalysisResult,
  type ForgeChange,
  type ForgeItem,
  type ForgeItemKind,
  type ForgeProposal,
  type ForgeProposalStatus,
  type ForgeReceipt,
  type ForgeReceiptState,
  type ForgeRun,
  type ForgeRunState
} from './forge-inbox-types'

function num(row: SqliteRow, column: string): number {
  const value = row[column]
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (typeof value !== 'number') {
    throw new Error(`forge inbox column ${column} is not a number`)
  }
  return value
}

function str(row: SqliteRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`forge inbox column ${column} is not text`)
  }
  return value
}

function optionalStr(row: SqliteRow, column: string): string | null {
  return row[column] === null ? null : str(row, column)
}

function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new Error(`forge inbox column ${column} holds unknown value ${value}`)
  }
  return match
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text)
}

export function itemFromRow(row: SqliteRow, readSeq: number | null): ForgeItem {
  const kind: ForgeItemKind = oneOf(FORGE_ITEM_KINDS, str(row, 'kind'), 'kind')
  const activitySeq = num(row, 'activity_seq')
  return {
    id: num(row, 'id'),
    hostId: str(row, 'host_id'),
    instanceId: str(row, 'instance_id'),
    projectId: str(row, 'project_id'),
    kind,
    iid: num(row, 'iid'),
    title: str(row, 'title'),
    state: str(row, 'state'),
    currentRevision: num(row, 'current_revision'),
    activitySeq,
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    unread: readSeq === null || readSeq < activitySeq
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The ledger only stores results it validated, so anything else here is corruption, not input. */
function analysisResultFromJson(text: string | null): ForgeAnalysisResult | null {
  if (text === null) {
    return null
  }
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || typeof value.summary !== 'string' || !Array.isArray(value.concerns)) {
    throw new Error('forge inbox run result is malformed')
  }
  const concerns = value.concerns.map((concern: unknown) => {
    if (typeof concern !== 'string') {
      throw new Error('forge inbox run result is malformed')
    }
    return concern
  })
  if (value.draft !== undefined && typeof value.draft !== 'string') {
    throw new Error('forge inbox run result is malformed')
  }
  return {
    summary: value.summary,
    concerns,
    ...(value.draft === undefined ? {} : { draft: value.draft })
  }
}

export function runFromRow(row: SqliteRow): ForgeRun {
  const state: ForgeRunState = oneOf(FORGE_RUN_STATES, str(row, 'state'), 'state')
  return {
    id: num(row, 'id'),
    itemId: num(row, 'item_id'),
    revision: num(row, 'revision'),
    state,
    generation: num(row, 'generation'),
    policyGeneration: num(row, 'policy_generation'),
    contextDigest: str(row, 'context_digest'),
    analysisKind: oneOf(FORGE_ITEM_KINDS, str(row, 'analysis_kind'), 'analysis_kind'),
    reason: str(row, 'reason'),
    error: optionalStr(row, 'error'),
    sessionId: optionalStr(row, 'session_id'),
    result: analysisResultFromJson(optionalStr(row, 'result_json')),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  }
}

const PROPOSAL_STATUSES: readonly ForgeProposalStatus[] = [
  'pending',
  'consumed',
  'rejected',
  'stale'
]

export function proposalFromRow(row: SqliteRow): ForgeProposal {
  return {
    id: num(row, 'id'),
    runId: num(row, 'run_id'),
    itemId: num(row, 'item_id'),
    revision: num(row, 'revision'),
    policyGeneration: num(row, 'policy_generation'),
    status: oneOf(PROPOSAL_STATUSES, str(row, 'status'), 'status'),
    body: parseJson(str(row, 'body_json')),
    createdAt: num(row, 'created_at'),
    resolvedAt: row.resolved_at === null ? null : num(row, 'resolved_at')
  }
}

const RECEIPT_STATES: readonly ForgeReceiptState[] = ['pending', 'applied', 'failed', 'unknown']

export function receiptFromRow(row: SqliteRow): ForgeReceipt {
  return {
    id: num(row, 'id'),
    proposalId: num(row, 'proposal_id'),
    idempotencyKey: str(row, 'idempotency_key'),
    state: oneOf(RECEIPT_STATES, str(row, 'state'), 'state'),
    result: parseJson(optionalStr(row, 'result_json')),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  }
}

const CHANGE_ENTITIES: readonly ForgeChange['entity'][] = ['event', 'run', 'proposal', 'receipt']

export function changeFromRow(row: SqliteRow): ForgeChange {
  return {
    seq: num(row, 'seq'),
    itemId: num(row, 'item_id'),
    entity: oneOf(CHANGE_ENTITIES, str(row, 'entity'), 'entity'),
    entityId: num(row, 'entity_id'),
    change: str(row, 'change'),
    createdAt: num(row, 'created_at')
  }
}

export { num as rowNumber, str as rowText }
