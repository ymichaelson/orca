import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ForgeInstanceScope, ForgeProposal } from '../../shared/forge-inbox-types'
import {
  FORGE_PUSH_MAX_MESSAGE_CHARS,
  type ForgePushApprovalRefusal
} from '../../shared/forge-push'
import { canonicalJson } from './forge-inbox-canonical-json'
import { recordForgeChange, type ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import {
  createForgeGitCommit,
  isForgeGitSha1,
  type ForgeGitIdentity,
  type ForgeGitObject
} from './forge-inbox-git-objects'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  hashForgePatchDraft,
  isForgePatchBranchAllowed,
  parseForgePatchDraft,
  type ForgePatchTarget
} from './forge-inbox-patch-draft'
import { policyGenerationOfItem } from './forge-inbox-policy'
import { approveForgeProposal } from './forge-inbox-proposal-approval'
import {
  appendForgeProposalInTransaction,
  readForgeProposal,
  readForgeReceiptForProposal
} from './forge-inbox-proposals'
import type { ForgePatchHeadReader } from './forge-inbox-patch-proposal'
import { readForgeItem } from './forge-inbox-queries'
import { rowNumber, rowText } from './forge-inbox-rows'
import { readForgeRun } from './forge-inbox-runs'

const IDENTITY = z
  .object({
    name: z.string(),
    email: z.string(),
    timeSeconds: z.number(),
    timezone: z.string()
  })
  .strict()

const PATCH_HASH = /^[0-9a-f]{64}$/

export type ForgePushCommit = {
  author: ForgeGitIdentity
  committer: ForgeGitIdentity
  message: string
}

/** The patch proposal whose applied manifest this push publishes; approval binds both ids. */
export type ForgePushPatchSource = { proposalId: number; hash: string }

/**
 * Everything the broker will push. The commit id is derived here so the approval binds the exact
 * object, not a description of one.
 */
export type ForgePushPlan = {
  kind: 'push'
  patch: ForgePushPatchSource
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
    patch: z
      .object({
        proposalId: z.number().int().positive(),
        hash: z.string().regex(PATCH_HASH)
      })
      .strict(),
    target: z
      .object({ instanceId: z.string().min(1).max(512), projectId: z.string().min(1).max(512) })
      .strict(),
    branch: z.string(),
    expectedHeadSha: z.string(),
    treeSha: z.string(),
    commitSha: z.string(),
    commit: z
      .object({
        author: IDENTITY,
        committer: IDENTITY,
        message: z.string().min(1).max(FORGE_PUSH_MAX_MESSAGE_CHARS)
      })
      .strict()
  })
  .strict()

export type ForgePushPlanFailure =
  | 'target-invalid'
  | 'branch-invalid'
  | 'base-invalid'
  | 'patch-invalid'
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
  if (
    !planSchema.shape.patch.safeParse(input.patch).success ||
    !Number.isSafeInteger(input.patch.proposalId)
  ) {
    return { ok: false, reason: 'patch-invalid' }
  }
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
  | 'patch-missing'
  | 'patch-mismatch'
  | 'patch-not-applied'

/** Creation-time refusals cannot come back from approval; the shared type keeps the mapping honest. */
export type ForgePushApprovalFailure = ForgePushApprovalRefusal

export type ForgePushProposalCreated =
  | { ok: true; proposal: ForgeProposal; plan: ForgePushPlan; hash: string }
  | { ok: false; reason: ForgePushProposalFailure }

/**
 * A push may only publish a patch the owner already approved and applied, so creation is gated on
 * that receipt rather than on a live run. The new proposal binds the item's current revision and
 * policy generation, which approval re-checks; a newer push for the item stales the older pending one.
 */
export function createForgePushProposal(
  ctx: ForgeLedgerContext,
  input: {
    scope: ForgeInstanceScope
    runId: number
    plan: Omit<ForgePushPlan, 'kind' | 'commitSha'>
  }
): ForgePushProposalCreated {
  const built = buildForgePushPlan(input.plan)
  if (!built.ok) {
    return built
  }
  const plan = built.plan
  return runForgeTransaction(ctx.db, (): ForgePushProposalCreated => {
    const run = readForgeRun(ctx, input.runId)
    if (!run) {
      return { ok: false, reason: 'run-missing' }
    }
    const item = readForgeItem(ctx, input.scope, run.itemId)
    if (!item) {
      return { ok: false, reason: 'item-missing' }
    }
    if (plan.target.instanceId !== item.instanceId || plan.target.projectId !== item.projectId) {
      return { ok: false, reason: 'item-mismatch' }
    }
    const patch = readForgeProposal(ctx, plan.patch.proposalId)
    if (!patch) {
      return { ok: false, reason: 'patch-missing' }
    }
    if (patch.runId !== run.id || patch.itemId !== item.id) {
      return { ok: false, reason: 'patch-mismatch' }
    }
    if (
      patch.status !== 'consumed' ||
      readForgeReceiptForProposal(ctx, patch.id)?.state !== 'applied'
    ) {
      return { ok: false, reason: 'patch-not-applied' }
    }
    const draft = parseForgePatchDraft(patch.body)
    if (draft === null) {
      return { ok: false, reason: 'patch-mismatch' }
    }
    if (
      hashForgePatchDraft(draft) !== plan.patch.hash ||
      draft.baseSha !== plan.expectedHeadSha ||
      draft.branch !== plan.branch ||
      draft.target.instanceId !== plan.target.instanceId ||
      draft.target.projectId !== plan.target.projectId
    ) {
      return { ok: false, reason: 'patch-mismatch' }
    }
    const proposal = appendForgeProposalInTransaction(ctx, {
      runId: run.id,
      itemId: item.id,
      revision: item.currentRevision,
      policyGeneration: policyGenerationOfItem(ctx, item.id),
      status: 'pending',
      body: plan
    })
    staleOlderPendingPushes(ctx, item.id, proposal.id)
    return { ok: true, proposal, plan, hash: built.hash }
  })
}

/** Only a pending push is replaced; a pending comment or patch keeps its own approval. */
function staleOlderPendingPushes(
  ctx: ForgeLedgerContext,
  itemId: number,
  keepProposalId: number
): void {
  const rows = ctx.db
    .prepare(
      "SELECT id, body_json FROM proposals WHERE item_id = ? AND status = 'pending' AND id <> ?"
    )
    .all(itemId, keepProposalId)
  const now = ctx.now()
  for (const row of rows) {
    const id = rowNumber(row, 'id')
    let body: unknown
    try {
      body = JSON.parse(rowText(row, 'body_json'))
    } catch {
      continue
    }
    if (parseForgePushPlan(body) === null) {
      continue
    }
    ctx.db
      .prepare(
        "UPDATE proposals SET status = 'stale', resolved_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(now, id)
    recordForgeChange(ctx, itemId, 'proposal', id, 'stale')
  }
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
  { ok: true; proposal: ForgeProposal } | { ok: false; reason: ForgePushApprovalFailure }
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
