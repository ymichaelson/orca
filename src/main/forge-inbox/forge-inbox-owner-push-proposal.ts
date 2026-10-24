import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import { buildForgePushPlan, type ForgePushCommit } from './forge-inbox-push-proposal'
import type { ForgePushProposalRefusal } from '../../shared/forge-push'
import type { MainHttpClient } from '../network/http-client'
import type { ForgeGitIdentity } from './forge-inbox-git-objects'
import { buildForgePushBaseTree, buildForgePushTree } from './forge-inbox-git-push-tree'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { hashForgePatchDraft, parseForgePatchDraft } from './forge-inbox-patch-draft'

export type ForgePushProposeRequest = {
  scope: ForgeInstanceScope
  runId: number
  /** The applied patch whose exact manifest this push publishes. */
  patchProposalId: number
  message: string
}

export type ForgePushProposeResult =
  | { kind: 'proposal'; proposalId: number; hash: string; commitSha: string; treeSha: string }
  | { kind: 'refused'; reason: ForgePushProposalRefusal }

export type ForgeOwnerPushPropose = (
  request: ForgePushProposeRequest,
  signal: AbortSignal
) => Promise<ForgePushProposeResult>

/**
 * Builds a push plan from the exact applied patch: the branch head and tree are read first, so a
 * moved base refuses instead of proposing a commit whose parent no longer exists. Nothing is
 * written to GitLab here; the plan is a local proposal the owner approves separately.
 */
export function createForgeOwnerPushPropose(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
  signal: AbortSignal
}): ForgeOwnerPushPropose {
  return async (request, signal) => {
    const combined = AbortSignal.any([deps.signal, signal])
    const run = deps.ledger.getRun(request.runId)
    if (!run) {
      return { kind: 'refused', reason: 'run-missing' }
    }
    const item = deps.ledger.getItem(request.scope, run.itemId)
    if (!item) {
      return { kind: 'refused', reason: 'item-missing' }
    }
    const patch = deps.ledger.getProposal(request.patchProposalId)
    if (!patch) {
      return { kind: 'refused', reason: 'patch-missing' }
    }
    if (patch.runId !== run.id || patch.itemId !== item.id) {
      return { kind: 'refused', reason: 'patch-mismatch' }
    }
    const applied = deps.ledger.getProposalReceipt(patch.id)?.state === 'applied'
    if (patch.status !== 'consumed' || !applied) {
      return { kind: 'refused', reason: 'patch-not-applied' }
    }
    const draft = parseForgePatchDraft(patch.body)
    if (
      draft === null ||
      draft.target.instanceId !== item.instanceId ||
      draft.target.projectId !== item.projectId
    ) {
      return { kind: 'refused', reason: 'patch-mismatch' }
    }
    const owner = createForgeOwnerGitlabReader(
      { ledger: deps.ledger, http: deps.http, signal: combined },
      draft.target
    )
    if (!owner.ok) {
      return { kind: 'refused', reason: 'project-unavailable' }
    }
    const [head, listing, user] = await Promise.all([
      owner.reader.getRepositoryBranchHead(draft.branch),
      owner.reader.listRepositoryTree(draft.baseSha),
      owner.reader.getCurrentUser()
    ])
    if (combined.aborted) {
      return { kind: 'refused', reason: 'base-unavailable' }
    }
    if (!head.ok) {
      return { kind: 'refused', reason: 'base-unavailable' }
    }
    if (head.data.sha !== draft.baseSha) {
      return { kind: 'refused', reason: 'base-moved' }
    }
    if (!listing.ok) {
      return { kind: 'refused', reason: 'base-unavailable' }
    }
    if (!listing.complete) {
      return { kind: 'refused', reason: 'base-unsupported' }
    }
    if (!user.ok) {
      return { kind: 'refused', reason: 'identity-unavailable' }
    }
    const entries = listing.data.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      id: entry.id
    }))
    const base = buildForgePushBaseTree(entries)
    if (!base.ok) {
      return { kind: 'refused', reason: 'base-unsupported' }
    }
    const tree = buildForgePushTree({ entries, draft })
    if (!tree.ok) {
      return { kind: 'refused', reason: 'tree-invalid' }
    }
    const commit = commitOf(user.data, deps.ledger.nowMs(), request.message)
    if (commit === null) {
      return { kind: 'refused', reason: 'identity-unavailable' }
    }
    const built = buildForgePushPlan({
      patch: { proposalId: patch.id, hash: hashForgePatchDraft(draft) },
      target: {
        instanceId: item.instanceId,
        projectId: item.projectId
      },
      branch: draft.branch,
      expectedHeadSha: draft.baseSha,
      treeSha: tree.rootTree,
      commit
    })
    if (!built.ok) {
      return { kind: 'refused', reason: built.reason }
    }
    const created = deps.ledger.createPushProposal({
      scope: request.scope,
      runId: run.id,
      plan: built.plan
    })
    if (!created.ok) {
      return { kind: 'refused', reason: created.reason }
    }
    return {
      kind: 'proposal',
      proposalId: created.proposal.id,
      hash: created.hash,
      commitSha: created.plan.commitSha,
      treeSha: created.plan.treeSha
    }
  }
}

/** The plan approves a host-built commit: the API user names it, and the host clock dates it. */
function commitOf(
  user: { name: string; email: string | null; commit_email: string | null },
  nowMs: number,
  message: string
): ForgePushCommit | null {
  const email = user.commit_email ?? user.email
  if (email === null || user.name === '') {
    return null
  }
  const identity: ForgeGitIdentity = {
    name: user.name,
    email,
    timeSeconds: Math.floor(nowMs / 1000),
    timezone: '+0000'
  }
  return { author: identity, committer: identity, message }
}
