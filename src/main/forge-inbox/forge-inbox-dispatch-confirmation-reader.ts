import { z } from 'zod'
import {
  createGitlabApiReaderWithRequesters,
  type GitlabApiReader,
  type GitlabApiRequesters
} from './forge-inbox-gitlab-api-client'
import type { GlabApiExec } from './forge-inbox-glab-api-requester'
import type {
  GitlabApiRequester,
  GitlabApiResult,
  GitlabApiScope
} from './forge-inbox-gitlab-api-request'
import { projectScopedRequesters } from './forge-inbox-project-event-observation'

export type ConfirmationMergeRequest = {
  iid: number
  state: string
  sha: string | null
  targetProjectId: number | null
  mergedBy: string | null
}

export type ConfirmationApprovals = {
  approved: boolean | null
  approvedBy: string[]
  userHasApproved: boolean | null
}

/** Reads only: the verifier can ask GitLab what happened but has no way to change anything. */
export type DispatchConfirmationReader = Pick<
  GitlabApiReader,
  'getCurrentUser' | 'listMergeRequestNotes' | 'listIssueNotes'
> & {
  getMergeRequestState(iid: number): Promise<GitlabApiResult<ConfirmationMergeRequest>>
  getMergeRequestApprovals(iid: number): Promise<GitlabApiResult<ConfirmationApprovals>>
}

export type DispatchConfirmationReaderFactory = (
  binding: { gitlabHost: string; repoPath: string; gitlabProjectId: number },
  signal?: AbortSignal
) => DispatchConfirmationReader

// Shapes below are as probed on GitLab CE 19.5; every field but state is optional so other versions degrade to unknown.
const userRef = z
  .object({ username: z.string() })
  .nullish()
  .catch(null)
  .transform((user) => user?.username ?? null)

const mergeRequestSchema = z
  .object({
    iid: z.number().int(),
    state: z.string(),
    sha: z.string().nullish().catch(null),
    target_project_id: z.number().int().nullish().catch(null),
    merged_by: userRef,
    merge_user: userRef
  })
  .transform((mr): ConfirmationMergeRequest => ({
    iid: mr.iid,
    state: mr.state,
    sha: mr.sha ?? null,
    targetProjectId: mr.target_project_id ?? null,
    mergedBy: mr.merged_by ?? mr.merge_user
  }))

const approvalEntry = z.object({ user: z.object({ username: z.string() }) })

const approvalsSchema = z
  .object({
    approved: z.boolean().nullish().catch(null),
    approved_by: z.array(z.unknown()).catch([]),
    user_has_approved: z.boolean().nullish().catch(null)
  })
  .transform((approvals): ConfirmationApprovals => ({
    approved: approvals.approved ?? null,
    approvedBy: approvals.approved_by.flatMap((entry) => {
      const parsed = approvalEntry.safeParse(entry)
      return parsed.success ? [parsed.data.user.username] : []
    }),
    userHasApproved: approvals.user_has_approved ?? null
  }))

async function getParsed<T>(
  requester: GitlabApiRequester,
  iid: number,
  path: string,
  schema: z.ZodType<T>
): Promise<GitlabApiResult<T>> {
  if (!Number.isSafeInteger(iid) || iid <= 0) {
    return { ok: false, code: 'bad-response' }
  }
  const response = await requester.get(path)
  if (!response.ok) {
    return response
  }
  const parsed = schema.safeParse(response.json)
  return parsed.success
    ? { ok: true, data: parsed.data, complete: true }
    : { ok: false, code: 'bad-response' }
}

export function createDispatchConfirmationReader(
  requesters: GitlabApiRequesters,
  scope: GitlabApiScope
): DispatchConfirmationReader {
  const base = createGitlabApiReaderWithRequesters(requesters, scope)
  return {
    getCurrentUser: base.getCurrentUser,
    listMergeRequestNotes: base.listMergeRequestNotes,
    listIssueNotes: base.listIssueNotes,
    getMergeRequestState: (iid) =>
      getParsed(requesters.requester, iid, `/merge_requests/${iid}`, mergeRequestSchema),
    getMergeRequestApprovals: (iid) =>
      getParsed(requesters.requester, iid, `/merge_requests/${iid}/approvals`, approvalsSchema)
  }
}

/** The host's reader: glab as the checkout sees it, bound to the project the binding names. */
export function createGlabDispatchConfirmationReaderFactory(
  exec?: GlabApiExec
): DispatchConfirmationReaderFactory {
  return (binding, signal) =>
    createDispatchConfirmationReader(
      projectScopedRequesters(
        binding.gitlabHost,
        binding.repoPath,
        binding.gitlabProjectId,
        exec,
        signal
      ),
      {
        baseUrl: `https://${binding.gitlabHost}`,
        projectId: String(binding.gitlabProjectId),
        expectedConfigRevision: 0
      }
    )
}
