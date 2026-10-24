import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import { isForgePatchBranchAllowed } from './forge-inbox-patch-draft'

export type ForgePatchTargetFailure =
  | 'target-unavailable'
  | 'target-identity'
  | 'target-branch'
  | 'target-head'

export type ForgePatchTargetVerification =
  | { ok: true; branch: string; headSha: string }
  | { ok: false; reason: ForgePatchTargetFailure }

export type ForgePatchTargetReader = Pick<
  GitlabApiReader,
  'getCurrentUser' | 'getMergeRequest' | 'getRepositoryBranchHead'
>

const SHA1 = /^[0-9a-f]{40}$/

/**
 * Proves the merge request, its source branch, and that branch's head are all the configured
 * project's before a paid turn reads or proposes anything. A fork is not this project's branch.
 */
export async function verifyForgePatchTarget(input: {
  reader: ForgePatchTargetReader
  projectId: string
  iid: number
}): Promise<ForgePatchTargetVerification> {
  const { reader } = input
  const identity = await reader.getCurrentUser()
  if (!identity.ok || !identity.complete) {
    return { ok: false, reason: 'target-unavailable' }
  }
  const mergeRequest = await reader.getMergeRequest(input.iid)
  if (!mergeRequest.ok || !mergeRequest.complete) {
    return { ok: false, reason: 'target-unavailable' }
  }
  const request = mergeRequest.data
  const configuredProject = Number(input.projectId)
  if (
    request.iid !== input.iid ||
    request.source_project_id !== configuredProject ||
    request.target_project_id !== configuredProject
  ) {
    return { ok: false, reason: 'target-identity' }
  }
  const branch = request.source_branch
  if (typeof branch !== 'string' || !isForgePatchBranchAllowed(branch)) {
    return { ok: false, reason: 'target-branch' }
  }
  const diffRefs = request.diff_refs
  if (
    typeof request.sha !== 'string' ||
    !SHA1.test(request.sha) ||
    diffRefs === null ||
    request.sha !== diffRefs.head_sha
  ) {
    return { ok: false, reason: 'target-head' }
  }
  const head = await reader.getRepositoryBranchHead(branch)
  if (!head.ok || !head.complete) {
    return { ok: false, reason: 'target-unavailable' }
  }
  if (head.data.sha !== request.sha) {
    return { ok: false, reason: 'target-head' }
  }
  return { ok: true, branch, headSha: request.sha }
}
