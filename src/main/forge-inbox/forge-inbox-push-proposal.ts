import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ForgeInstanceScope, ForgeProposal } from '../../shared/forge-inbox-types'
import { canonicalJson } from './forge-inbox-canonical-json'
import { isForgePatchBranchAllowed, type ForgePatchTarget } from './forge-inbox-patch-draft'
import {
  createForgeGitCommit,
  isForgeGitSha1,
  type ForgeGitIdentity,
  type ForgeGitObject
} from './forge-inbox-git-objects'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { approveForgeProposal } from './forge-inbox-proposal-approval'
import type { ForgePatchHeadReader } from './forge-inbox-patch-proposal'

const IDENTITY = z
  .object({
    name: z.string(),
    email: z.string(),
    timeSeconds: z.number(),
    timezone: z.string()
  })
  .strict()

export type ForgePushCommit = {
  author: ForgeGitIdentity
  committer: ForgeGitIdentity
  message: string
}

/**
 * Everything the broker will push. The commit id is derived here so the approval binds the exact
 * object, not a description of one.
 */
export type ForgePushPlan = {
  kind: 'push'
  target: ForgePatchTarget
  branch: string
  /** The branch head the new commit's parent must be; approval stales when it moves. */
  expectedHeadSha: string
  treeSha: string
  commitSha: string
  commit: ForgePushCommit
}

const planSchema = z
  .object({
    kind: z.literal('push'),
    target: z
      .object({ instanceId: z.string().min(1).max(512), projectId: z.string().min(1).max(512) })
      .strict(),
    branch: z.string(),
    expectedHeadSha: z.string(),
    treeSha: z.string(),
    commitSha: z.string(),
    commit: z.object({ author: IDENTITY, committer: IDENTITY, message: z.string() }).strict()
  })
  .strict()

export type ForgePushPlanFailure =
  | 'target-invalid'
  | 'branch-invalid'
  | 'base-invalid'
  | 'tree-invalid'
  | 'commit-invalid'
  | 'commit-mismatch'

export type ForgePushPlanResult =
  | { ok: true; plan: ForgePushPlan; hash: string }
  | { ok: false; reason: ForgePushPlanFailure }

export function hashForgePushPlan(plan: ForgePushPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

/** The exact commit object the approved plan names; null only for a plan parse already rejected. */
export function createForgePushCommit(plan: ForgePushPlan): ForgeGitObject | null {
  return commitObjectOf(plan)
}

function commitObjectOf(plan: Omit<ForgePushPlan, 'commitSha'>) {
  return createForgeGitCommit({
    tree: plan.treeSha,
    parents: [plan.expectedHeadSha],
    author: plan.commit.author,
    committer: plan.commit.committer,
    message: plan.commit.message
  })
}

export function buildForgePushPlan(
  input: Omit<ForgePushPlan, 'kind' | 'commitSha'>
): ForgePushPlanResult {
  if (!planSchema.shape.target.safeParse(input.target).success) {
    return { ok: false, reason: 'target-invalid' }
  }
  if (!isForgePatchBranchAllowed(input.branch)) {
    return { ok: false, reason: 'branch-invalid' }
  }
  if (!isForgeGitSha1(input.expectedHeadSha)) {
    return { ok: false, reason: 'base-invalid' }
  }
  if (!isForgeGitSha1(input.treeSha)) {
    return { ok: false, reason: 'tree-invalid' }
  }
  const plan = { ...input, kind: 'push' as const, commitSha: '' }
  const commit = commitObjectOf(plan)
  if (commit === null) {
    return { ok: false, reason: 'commit-invalid' }
  }
  const withSha: ForgePushPlan = { ...plan, commitSha: commit.oid }
  return { ok: true, plan: withSha, hash: hashForgePushPlan(withSha) }
}

/** Null unless the body is a push plan whose claimed commit id is the one its fields produce. */
export function parseForgePushPlan(body: unknown): ForgePushPlan | null {
  const parsed = planSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const plan: ForgePushPlan = parsed.data
  const commit = commitObjectOf(plan)
  return commit !== null && commit.oid === plan.commitSha ? plan : null
}

export type ForgePushProposalFailure =
  | ForgePushPlanFailure
  | 'run-missing'
  | 'item-missing'
  | 'item-mismatch'
  | 'run-not-running'
  | 'generation-mismatch'
  | 'not-found'
  | 'not-pending'
  | 'not-a-push'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'
  | 'stale'

export type ForgePushProposalCreated =
  | { ok: true; proposal: ForgeProposal; plan: ForgePushPlan; hash: string }
  | { ok: false; reason: ForgePushProposalFailure }

export function createForgePushProposal(
  deps: { ledger: Pick<ForgeInboxLedger, 'getRun' | 'getItem' | 'createProposal'> },
  input: {
    scope: ForgeInstanceScope
    runId: number
    expectedGeneration: number
    plan: Omit<ForgePushPlan, 'kind' | 'commitSha'>
  }
): ForgePushProposalCreated {
  const built = buildForgePushPlan(input.plan)
  if (!built.ok) {
    return built
  }
  const run = deps.ledger.getRun(input.runId)
  if (!run) {
    return { ok: false, reason: 'run-missing' }
  }
  const item = deps.ledger.getItem(input.scope, run.itemId)
  if (!item) {
    return { ok: false, reason: 'item-missing' }
  }
  if (
    built.plan.target.instanceId !== item.instanceId ||
    built.plan.target.projectId !== item.projectId
  ) {
    return { ok: false, reason: 'item-mismatch' }
  }
  const created = deps.ledger.createProposal({
    runId: input.runId,
    expectedGeneration: input.expectedGeneration,
    body: built.plan,
    supersedePending: true
  })
  if (!created.ok) {
    return created
  }
  return { ok: true, proposal: created.proposal, plan: built.plan, hash: built.hash }
}

/** Consumes exactly one push approval; a moved branch makes it stale, an unreadable one keeps it pending. */
export async function approveForgePush(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'consumeProposal' | 'staleProposal'>
    readHead: ForgePatchHeadReader
  },
  input: {
    scope: ForgeInstanceScope
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  },
  signal: AbortSignal
): Promise<
  { ok: true; proposal: ForgeProposal } | { ok: false; reason: ForgePushProposalFailure }
> {
  const result = await approveForgeProposal(
    {
      ledger: deps.ledger,
      parseDraft: parseForgePushPlan,
      hashDraft: hashForgePushPlan,
      checkHead: async (plan) => {
        const head = await deps.readHead(
          {
            instanceId: plan.target.instanceId,
            projectId: plan.target.projectId,
            branch: plan.branch
          },
          signal
        )
        if (!head.ok) {
          return 'head-unavailable'
        }
        return head.sha === plan.expectedHeadSha ? 'ok' : 'head-moved'
      }
    },
    input
  )
  if (result.ok) {
    return result
  }
  return result.reason === 'not-this-kind'
    ? { ok: false, reason: 'not-a-push' }
    : { ok: false, reason: result.reason }
}
