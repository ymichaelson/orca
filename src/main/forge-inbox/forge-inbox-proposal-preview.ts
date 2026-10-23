import type { ForgeProposalPreview } from '../../shared/forge-inbox-rpc-types'
import type { ForgeProposal } from '../../shared/forge-inbox-types'
import { hashForgeCommentDraft, parseForgeCommentDraft } from './forge-inbox-comment-draft'
import { hashForgePatchDraft, parseForgePatchDraft } from './forge-inbox-patch-draft'
import { hashForgePushPlan, parseForgePushPlan } from './forge-inbox-push-proposal'

/**
 * What the approval dialog may show. A body that parses as none of the known drafts is still
 * reported so its status is visible, but it carries no hash and can only be rejected.
 */
export function previewForgeProposal(proposal: ForgeProposal): ForgeProposalPreview {
  const base = {
    proposalId: proposal.id,
    status: proposal.status,
    revision: proposal.revision,
    policyGeneration: proposal.policyGeneration,
    createdAt: proposal.createdAt,
    resolvedAt: proposal.resolvedAt
  }
  const comment = parseForgeCommentDraft(proposal.body)
  if (comment) {
    return {
      ...base,
      kind: 'comment',
      hash: hashForgeCommentDraft(comment),
      target: comment.target,
      headSha: comment.headSha,
      body: comment.body
    }
  }
  const patch = parseForgePatchDraft(proposal.body)
  if (patch) {
    return {
      ...base,
      kind: 'patch',
      hash: hashForgePatchDraft(patch),
      target: patch.target,
      baseSha: patch.baseSha,
      branch: patch.branch,
      files: patch.operations.map((operation) => ({
        op: operation.op,
        path: operation.path,
        contentBytes: operation.op === 'delete' ? 0 : Buffer.byteLength(operation.content, 'utf8'),
        baseSha256: operation.op === 'create' ? null : operation.baseSha256,
        resultSha256: operation.op === 'delete' ? null : operation.resultSha256
      }))
    }
  }
  const push = parseForgePushPlan(proposal.body)
  if (push) {
    return {
      ...base,
      kind: 'push',
      hash: hashForgePushPlan(push),
      target: push.target,
      branch: push.branch,
      expectedHeadSha: push.expectedHeadSha,
      commitSha: push.commitSha,
      message: push.commit.message
    }
  }
  return { ...base, kind: 'unknown', hash: null }
}
