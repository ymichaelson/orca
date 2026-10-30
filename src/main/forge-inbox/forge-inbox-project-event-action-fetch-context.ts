import type { ForgeLedgerContext } from './forge-inbox-context'
import type {
  ForgeProjectEventAgentLaunchFactory,
  ForgeProjectEventAgentLaunchOpener
} from './forge-inbox-project-event-agent-launch'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type {
  ProjectEventActionClaim,
  ProjectEventActionOutcome
} from './forge-inbox-project-event-action-types'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL } from './forge-inbox-project-event-delivery-head-join'
import type { ProjectEventHeadObservation } from './forge-inbox-project-event-observation'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import { isRecord, rowNumber, rowText } from './forge-inbox-rows'
import type { ForgeWebhookQueueLimits } from './forge-inbox-webhook-queue'

/** Only round 0 may read: round 1 already reaches the cap, so a chain fetches GitLab once. */
const PROJECT_EVENT_CONTEXT_MAX_ROUNDS = 2
const TITLE_LIMIT = 512
const TEXT_LIMIT = 256

export type ProjectEventActionDeps = {
  observeContext?: (
    claim: ProjectEventActionClaim,
    signal?: AbortSignal
  ) => Promise<ProjectEventHeadObservation>
  limits: ForgeWebhookQueueLimits
  /** Each dispatch builds its own launch, so an owner can stop one without killing the next. */
  launchAgentFactory?: ForgeProjectEventAgentLaunchFactory
  /** The owner's fence around that factory call; without one the launch is not fenced. */
  launchAgentOpener?: ForgeProjectEventAgentLaunchOpener
  /** The ledger the factory opens its launch on; the drain's context is not the ledger itself. */
  launchAgentLedger?: ForgeInboxLedger
}

type ObservedHead = Extract<ProjectEventHeadObservation, { ok: true }>

function blocked(code: string): ProjectEventActionOutcome {
  return { kind: 'blocked', code }
}

function boundedText(value: string | null, limit: number): string | null {
  return value === null ? null : value.slice(0, limit)
}

/** A missing, unreadable or forged round reads as zero and is clamped to the cap. */
function projectEventContextRound(body: unknown): number {
  if (!(body instanceof Uint8Array)) {
    return 0
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (!isRecord(parsed)) {
      return 0
    }
    const round = parsed.context_round
    if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0) {
      return 0
    }
    return Math.min(round, PROJECT_EVENT_CONTEXT_MAX_ROUNDS)
  } catch {
    return 0
  }
}

type ContextRequest = { itemId: number; kind: string; versionToken: string; category: string }

/** The revision token and category whose read this fetch request stands for. */
function requestContext(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim
): ContextRequest | null {
  const row = ctx.db
    .prepare(
      `SELECT d.item_id, d.version_token, i.kind,
         CASE WHEN json_valid(d.payload_json)
           THEN COALESCE(json_extract(d.payload_json, '$.category'), i.kind)
           ELSE i.kind END AS category
       FROM webhook_deliveries w
       ${PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL}
       WHERE w.id = ? AND w.host_id = ?`
    )
    .get(claim.deliveryId, ctx.hostId)
  return row === undefined
    ? null
    : {
        itemId: rowNumber(row, 'item_id'),
        kind: rowText(row, 'kind'),
        versionToken: rowText(row, 'version_token'),
        category: rowText(row, 'category')
      }
}

/** A fetch is a deterministic read of one revision and category; a repeat learns nothing new. */
function contextAlreadyFetched(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  request: ContextRequest
): boolean {
  const row = ctx.db
    .prepare(
      `SELECT 1 AS found
       FROM project_event_decisions pd
       JOIN webhook_deliveries w ON w.id = pd.delivery_id AND w.host_id = pd.host_id
       ${PROJECT_EVENT_DELIVERY_HEAD_JOIN_SQL}
       WHERE pd.host_id = ? AND pd.action = 'fetch_context' AND pd.id <> ?
         AND d.item_id = ? AND d.version_token = ?
         AND CASE WHEN json_valid(d.payload_json)
           THEN COALESCE(json_extract(d.payload_json, '$.category'), i.kind)
           ELSE i.kind END = ?
         AND (pd.action_state = 'done'
           OR (pd.action_state = 'blocked'
             AND pd.last_error_code IN ('context-unchanged', 'interrupted-action')))
       LIMIT 1`
    )
    .get(ctx.hostId, claim.decisionId, request.itemId, request.versionToken, request.category)
  return row !== undefined
}

/** The observed head in the shape the normal decision path already parses. */
function contextBody(observed: ObservedHead, round: number, projectId: number): Buffer {
  const reread = { context_round: round, context_source: 'observation' }
  if (observed.kind === 'pipeline') {
    return Buffer.from(
      JSON.stringify({
        object_kind: 'pipeline',
        project: { id: projectId },
        object_attributes: {
          id: observed.iid,
          status: boundedText(observed.state, TEXT_LIMIT) ?? '',
          sha: boundedText(observed.sha, TEXT_LIMIT)
        },
        ...reread
      })
    )
  }
  const item = {
    iid: observed.iid,
    title: boundedText(observed.title, TITLE_LIMIT),
    state: boundedText(observed.state, TEXT_LIMIT),
    sha: boundedText(observed.sha, TEXT_LIMIT)
  }
  return Buffer.from(
    JSON.stringify({
      object_kind: observed.kind,
      project: { id: projectId },
      object_attributes: { ...item, action: 'update' },
      [observed.kind]: item,
      ...reread
    })
  )
}

/** The observed head is re-decided as its own delivery; a failed read is recorded, never degraded. */
export async function fetchProjectEventContext(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  deps: ProjectEventActionDeps,
  signal?: AbortSignal
): Promise<ProjectEventActionOutcome | null> {
  const delivery = ctx.db
    .prepare('SELECT body FROM webhook_deliveries WHERE id = ? AND host_id = ?')
    .get(claim.deliveryId, ctx.hostId)
  if (!delivery) {
    return blocked('invalid-input')
  }
  const round = projectEventContextRound(delivery.body)
  if (round + 1 >= PROJECT_EVENT_CONTEXT_MAX_ROUNDS) {
    return blocked('context-rounds-exhausted')
  }
  const request = requestContext(ctx, claim)
  if (!request) {
    return blocked('invalid-input')
  }
  // A project event is complete as delivered; GitLab holds no object to read it back from.
  if (request.kind === 'project') {
    return blocked('context-unavailable')
  }
  if (contextAlreadyFetched(ctx, claim, request)) {
    return blocked('context-already-fetched')
  }
  if (!deps.observeContext) {
    return blocked('context-unavailable')
  }
  if (signal?.aborted) {
    return null
  }
  const observed = await deps.observeContext(claim, signal)
  if (signal?.aborted) {
    return null
  }
  if (!observed.ok) {
    return blocked(observed.code)
  }
  if (!observed.newRevision) {
    return blocked('context-unchanged')
  }
  // The observation compares this column against the binding's gitlab_path, so it must be the path.
  const binding = ctx.db
    .prepare('SELECT gitlab_path, gitlab_project_id FROM project_bindings WHERE binding_id = ?')
    .get(claim.bindingId)
  const projectPath = binding ? rowText(binding, 'gitlab_path') : ''
  const projectId = binding ? rowNumber(binding, 'gitlab_project_id') : 0
  if (!projectPath || !Number.isSafeInteger(projectId) || projectId <= 0) {
    return blocked('binding-missing')
  }
  const policy = getProjectEventPolicy(ctx, claim.repoId)
  const admitted = admitProjectEventDelivery(ctx, deps.limits, {
    bindingId: claim.bindingId,
    projectPath,
    policyGeneration: policy?.generation ?? null,
    policyEnabled: policy?.enabled ?? false,
    eventKind: observed.kind,
    dedupeKey: `context:${claim.decisionId}:${round + 1}:${observed.versionToken}`,
    correlation: { eventUuid: null, configUuid: null },
    body: contextBody(observed, round + 1, projectId)
  })
  return admitted.ok ? { kind: 'done' } : blocked(admitted.reason)
}
