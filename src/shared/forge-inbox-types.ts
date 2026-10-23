export const FORGE_ITEM_KINDS = ['issue', 'merge_request', 'pipeline'] as const
export type ForgeItemKind = (typeof FORGE_ITEM_KINDS)[number]

export const FORGE_RUN_STATES = [
  'queued',
  'running',
  'awaiting-approval',
  'succeeded',
  'failed',
  'cancelled',
  'unverifiable',
  'superseded'
] as const
export type ForgeRunState = (typeof FORGE_RUN_STATES)[number]

export type ForgeProposalStatus = 'pending' | 'consumed' | 'rejected' | 'stale'
export type ForgeReceiptState = 'pending' | 'applied' | 'failed' | 'unknown'

/** Owner-qualified: the same project path on another host or configured instance is a different item. */
export type ForgeItemKey = {
  hostId: string
  instanceId: string
  projectId: string
  kind: ForgeItemKind
  iid: number
}

export type ForgeEventIngest = ForgeItemKey & {
  /**
   * Retry-stable key from ingress (webhook-id / Idempotency-Key). Never X-Gitlab-Event-UUID:
   * GitLab can share it across distinct recursive messages.
   */
  dedupeKey: string
  eventKind: string
  payload: unknown
  /** Opaque forge version (e.g. head sha); identity only, never compared for order. */
  versionToken: string
  /**
   * Ingress-normalized monotonic ordering of the version (source timestamp or snapshot order). The
   * head only advances to a token with a strictly greater order; webhook-only deliveries with no
   * trustworthy order must reuse the head's order and wait for an authoritative snapshot.
   */
  sourceOrder: number
  title?: string
  itemState?: string
  /** Passive events record history only; a run is queued solely when this is set. */
  queueRun?: { reason: string }
}

export type ForgeIngestResult =
  | { duplicate: true; eventId: number }
  | {
      duplicate: false
      eventId: number
      itemId: number
      revision: number
      /** False when the head did not move (reordered or repeated version). */
      newRevision: boolean
      seq: number
      runId: number | null
    }

export type ForgeItem = ForgeItemKey & {
  id: number
  title: string
  state: string
  currentRevision: number
  activitySeq: number
  createdAt: number
  updatedAt: number
  unread: boolean
}

export type ForgeRevision = {
  id: number
  itemId: number
  revision: number
  versionToken: string
  createdAt: number
}

/** What one analysis produced; the text is model output, so it is only ever rendered as untrusted. */
export type ForgeAnalysisResult = {
  summary: string
  concerns: string[]
  draft?: string
}

export type ForgeRun = {
  id: number
  itemId: number
  revision: number
  state: ForgeRunState
  /** State-transition compare-and-swap counter, not the project policy generation. */
  generation: number
  /** Immutable project policy generation the run was queued under. */
  policyGeneration: number
  /** The analysis context this run was paid for; the same digest is never analysed twice. */
  contextDigest: string
  analysisKind: ForgeItemKind
  reason: string
  error: string | null
  /** Persisted before the agent is sent anything, so a restart can reconcile the same session. */
  sessionId: string | null
  result: ForgeAnalysisResult | null
  createdAt: number
  updatedAt: number
}

export type ForgeProposal = {
  id: number
  runId: number
  itemId: number
  revision: number
  /** Durable per-project policy generation the proposal was made under; a bump revokes it. */
  policyGeneration: number
  status: ForgeProposalStatus
  body: unknown
  createdAt: number
  resolvedAt: number | null
}

export type ForgeReceipt = {
  id: number
  proposalId: number
  idempotencyKey: string
  state: ForgeReceiptState
  result: unknown
  createdAt: number
  updatedAt: number
}

export type ForgeChange = {
  seq: number
  itemId: number
  entity: 'event' | 'run' | 'proposal' | 'receipt'
  entityId: number
  change: string
  createdAt: number
}

/** The only parts of a stored event payload a client may see. */
export type ForgePipelineFacts = { id: number; status?: string; sha?: string; ref?: string }

export type ForgeEventSummary = {
  category?: string
  passive?: boolean
  completeness?: { complete: boolean; notes?: boolean; diffs?: boolean; ci?: boolean }
  /** observed comes from the API; reported is the unverified hook claim. */
  pipeline?: { observed?: ForgePipelineFacts; reported?: ForgePipelineFacts }
}

export type ForgeEvent = {
  id: number
  itemId: number
  /** Head revision the event was attached to, which can differ from the version it reported. */
  revision: number
  eventKind: string
  versionToken: string
  sourceOrder: number
  receivedAt: number
  summary: ForgeEventSummary
}

export type ForgePage<T> = { rows: T[]; nextCursor: number | null }

/** Reads are always bound to the ledger's owner host; callers may only narrow to one instance. */
export type ForgeInstanceScope = { instanceId?: string }
