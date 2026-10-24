import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import { createGitlabPatchSource } from './forge-inbox-gitlab-patch-source'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { buildForgePatchDraft } from './forge-inbox-patch-draft'
import {
  forgePatchPathSets,
  forgePatchPathsFromDiffs,
  readForgePatchContext
} from './forge-inbox-patch-context'
import {
  buildForgePatchPrompt,
  forgePatchOperationsFromCandidate,
  parseForgePatchCandidate
} from './forge-inbox-patch-prompt'
import {
  FORGE_PATCH_REQUEST_FAILURE_REASONS,
  type ForgePatchRequestFailureReason,
  type ForgePatchRequestUnverifiableReason
} from './forge-inbox-patch-request-completion'
import { FORGE_PATCH_REQUEST_INTERRUPTED } from './forge-inbox-patch-request-record'
import type { ForgePatchRequest, ForgePatchRequestRefusal } from './forge-inbox-patch-requests'
import { verifyForgePatchTarget } from './forge-inbox-patch-target'
import {
  isForgeProtectedSessionFor,
  type ForgeProtectedSessionRecord
} from './forge-inbox-protected-session-binding'
import {
  sendForgeProtectedSessionTurn,
  type ForgeProtectedSessionTurnHost
} from './forge-inbox-protected-session-turn'

export type ForgePatchProduceRefusal =
  | ForgePatchRequestRefusal
  | 'session-missing'
  | 'session-not-protected'
  | 'send-refused'
  | 'finish-refused'

export type ForgePatchProduceResult =
  | { kind: 'proposal'; proposalId: number; requestId: number }
  | { kind: 'in-progress' }
  | { kind: 'failed'; reason: ForgePatchRequestFailureReason }
  | {
      kind: 'unverifiable'
      reason: ForgePatchRequestUnverifiableReason | typeof FORGE_PATCH_REQUEST_INTERRUPTED
    }
  | { kind: 'refused'; reason: ForgePatchProduceRefusal }

export type ForgePatchProduceRequest = {
  scope: ForgeInstanceScope
  callerKey: string
  operationId: string
  runId: number
  message: string
  /** Empty means derive the changed paths from the merge request's diffs. */
  paths: readonly string[]
}

export type ForgeInboxPatchProducer = (
  request: ForgePatchProduceRequest,
  signal: AbortSignal
) => Promise<ForgePatchProduceResult>

type PatchProducerLedger = Pick<
  ForgeInboxLedger,
  | 'claimPatchRequest'
  | 'checkPatchRequestFences'
  | 'finishPatchRequest'
  | 'getRun'
  | 'getItem'
  | 'getConfig'
>

type ProduceContext = {
  ledger: PatchProducerLedger
  scope: ForgeInstanceScope
  callerKey: string
  request: ForgePatchRequest
}

type SettleOutcome =
  | { kind: 'failed'; reason: ForgePatchRequestFailureReason }
  | { kind: 'unverifiable'; reason: ForgePatchRequestUnverifiableReason }

function settleRequest(ctx: ProduceContext, outcome: SettleOutcome): ForgePatchProduceResult {
  const { ledger, scope, callerKey, request } = ctx
  const finished = ledger.finishPatchRequest({
    scope,
    callerKey,
    requestId: request.id,
    expectedRequestDigest: request.requestDigest,
    outcome
  })
  return finished.kind === 'refused' ? { kind: 'refused', reason: 'finish-refused' } : outcome
}

/** A claimed request that already settled replays its coded answer without any new work. */
function settledResult(request: ForgePatchRequest): ForgePatchProduceResult {
  if (request.state === 'succeeded' && request.proposalId !== null) {
    return { kind: 'proposal', proposalId: request.proposalId, requestId: request.id }
  }
  if (request.state === 'failed') {
    const known = FORGE_PATCH_REQUEST_FAILURE_REASONS.find(
      (reason) => reason === request.reasonCode
    )
    return { kind: 'failed', reason: known ?? 'producer-failed' }
  }
  const interrupted = request.reasonCode === FORGE_PATCH_REQUEST_INTERRUPTED
  return { kind: 'unverifiable', reason: interrupted ? 'interrupted' : 'unknown-outcome' }
}

/**
 * Produces at most one patch proposal for a claimed request. The claim is the only entry point, the
 * record must re-prove its binding around host installation, and the merge request is re-read
 * before, between, and after the single protected turn so a moving branch can never be patched.
 */
export function createForgeInboxPatchProducer(deps: {
  ledger: PatchProducerLedger
  openReader: () => Promise<GitlabApiReader | null>
  ensureHost: () => Promise<ForgeProtectedSessionTurnHost>
  readRecord: (
    sessionId: string
  ) => ForgeProtectedSessionRecord | null | Promise<ForgeProtectedSessionRecord | null>
}): ForgeInboxPatchProducer {
  const { ledger } = deps
  return async (input, signal) => {
    const { scope, callerKey } = input
    const claimed = ledger.claimPatchRequest({
      scope,
      callerKey,
      operationId: input.operationId,
      runId: input.runId,
      intent: { message: input.message, paths: input.paths }
    })
    if (claimed.kind === 'refused') {
      return { kind: 'refused', reason: claimed.reason }
    }
    if (claimed.kind !== 'claimed') {
      return claimed.kind === 'in-progress'
        ? { kind: 'in-progress' }
        : settledResult(claimed.request)
    }
    const request = claimed.request
    const ctx: ProduceContext = { ledger, scope, callerKey, request }
    let stage: 'working' | 'sent' | 'settling' = 'working'
    const settle = (outcome: SettleOutcome): ForgePatchProduceResult => {
      stage = 'settling'
      return settleRequest(ctx, outcome)
    }
    const settleFailed = (reason: ForgePatchRequestFailureReason) =>
      settle({ kind: 'failed', reason })
    const settleRefused = (reason: ForgePatchProduceRefusal): ForgePatchProduceResult => {
      settleFailed('session-binding-lost')
      return { kind: 'refused', reason }
    }

    try {
      // The fences are re-proved against the ledger before anything is read or spawned.
      const fences = ledger.checkPatchRequestFences(request)
      if (!fences.ok) {
        return settleFailed(fences.reason)
      }
      const run = ledger.getRun(request.runId)
      if (
        !run ||
        run.itemId !== request.itemId ||
        run.generation !== request.runGeneration ||
        run.revision !== request.revision
      ) {
        return settleFailed('run-mismatch')
      }
      if (run.sessionId !== request.sessionId) {
        return settleFailed('session-mismatch')
      }
      if (run.state !== 'succeeded' && run.state !== 'awaiting-approval') {
        return settleFailed('run-not-eligible')
      }
      const item = ledger.getItem(scope, request.itemId)
      if (!item || item.kind !== 'merge_request') {
        return settleFailed(item ? 'item-not-merge-request' : 'run-mismatch')
      }
      if (item.currentRevision !== request.revision) {
        return settleFailed('revision-stale')
      }
      const config = ledger.getConfig()
      const project = config.config.instances
        .find((instance) => instance.id === item.instanceId)
        ?.projects.find((candidate) => candidate.projectId === item.projectId)
      if (!project?.enabled) {
        return settleFailed('project-unavailable')
      }
      if (config.configRevision !== request.configRevision) {
        return settleFailed('config-stale')
      }

      const subject: AgentSessionProtectedAnalysis = {
        ownerId: item.hostId,
        instanceId: item.instanceId,
        itemId: String(item.id),
        analysisKind: item.kind
      }
      const record = await deps.readRecord(request.sessionId)
      if (!record || !isForgeProtectedSessionFor(record, subject)) {
        return settleRefused(record ? 'session-not-protected' : 'session-missing')
      }

      const reader = await deps.openReader()
      if (!reader) {
        return settleFailed('producer-failed')
      }
      const verify = async () =>
        verifyForgePatchTarget({ reader, projectId: item.projectId, iid: item.iid })
      const first = await verify()
      if (!first.ok) {
        return settleFailed('target-mismatch')
      }

      let paths = [...input.paths]
      if (paths.length === 0) {
        const diffs = await reader.getMergeRequestDiffs(item.iid)
        if (!diffs.ok || !diffs.complete) {
          return settleFailed('producer-failed')
        }
        const derived = forgePatchPathsFromDiffs(diffs.data)
        if (derived === null) {
          return settleFailed('producer-failed')
        }
        paths = derived
      }
      const context = await readForgePatchContext({
        source: createGitlabPatchSource({ reader, ref: first.headSha }),
        paths
      })
      if (!context.ok) {
        return settleFailed('producer-failed')
      }
      const { present, missing, baseHashes } = forgePatchPathSets(context.entries)
      const prompt = buildForgePatchPrompt({
        subject,
        revision: request.revision,
        message: input.message,
        entries: context.entries
      })

      const host = await deps.ensureHost()
      // Installing the host may have replaced, unprotected, or moved the record's fence.
      const recheck = await deps.readRecord(request.sessionId)
      if (!recheck || !isForgeProtectedSessionFor(recheck, subject)) {
        return settleRefused(recheck ? 'session-not-protected' : 'session-missing')
      }
      if (recheck.lease.runtimeFence !== record.lease.runtimeFence) {
        return settleRefused('send-refused')
      }
      const second = await verify()
      if (!second.ok || second.branch !== first.branch || second.headSha !== first.headSha) {
        return settleFailed('target-mismatch')
      }
      if (signal.aborted) {
        return settleFailed('producer-failed')
      }

      stage = 'sent'
      const outcome = await sendForgeProtectedSessionTurn({
        host,
        callerKey: `forge-propose-patch:${request.sessionId}`,
        sessionId: request.sessionId,
        fence: recheck.lease.runtimeFence,
        prompt,
        signal
      })
      if (outcome.kind === 'refused') {
        return settleFailed('producer-failed')
      }
      if (outcome.kind === 'unknown') {
        return settle({ kind: 'unverifiable', reason: 'unknown-outcome' })
      }

      const candidate = parseForgePatchCandidate(outcome.text, { present, missing })
      if (!candidate) {
        return settleFailed('draft-invalid')
      }
      const third = await verify()
      if (!third.ok || third.branch !== first.branch || third.headSha !== first.headSha) {
        return settleFailed('target-mismatch')
      }
      const operations = forgePatchOperationsFromCandidate(candidate, baseHashes)
      if (!operations) {
        return settleFailed('draft-invalid')
      }
      const draft = buildForgePatchDraft({
        target: { instanceId: item.instanceId, projectId: item.projectId },
        baseSha: first.headSha,
        branch: first.branch,
        operations
      })
      if (!draft.ok) {
        return settleFailed('draft-invalid')
      }

      stage = 'settling'
      const finished = ledger.finishPatchRequest({
        scope,
        callerKey,
        requestId: request.id,
        expectedRequestDigest: request.requestDigest,
        outcome: { kind: 'success', draft: draft.draft, expectedDraftHash: draft.hash }
      })
      if (finished.kind === 'refused') {
        return { kind: 'refused', reason: 'finish-refused' }
      }
      return finished.proposal
        ? { kind: 'proposal', proposalId: finished.proposal.id, requestId: request.id }
        : settledResult(finished.request)
    } catch (error) {
      if (stage === 'settling') {
        throw error
      }
      return stage === 'sent'
        ? settle({ kind: 'unverifiable', reason: 'unknown-outcome' })
        : settle({ kind: 'failed', reason: 'producer-failed' })
    }
  }
}
