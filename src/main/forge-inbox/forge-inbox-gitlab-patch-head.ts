import type { MainHttpClient } from '../network/http-client'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { ForgePatchHeadReader } from './forge-inbox-patch-proposal'

export type GitlabPatchHeadReaderDeps = {
  http: Pick<MainHttpClient, 'fetch'>
  /** api-read only: approval never needs the write credential. */
  readReadToken: (instanceId: string) => string | null
  readConfigRevision: () => number
  expectedConfigRevision: number
  resolveInstanceBaseUrl: (instanceId: string) => string | null
}

/**
 * Reads the head of a branch in the configured project the draft was bound to. Fork targets are
 * not resolved here; a producer that sees a different source project must fail closed.
 */
export function createGitlabPatchHeadReader(deps: GitlabPatchHeadReaderDeps): ForgePatchHeadReader {
  return async (request, signal) => {
    const baseUrl = deps.resolveInstanceBaseUrl(request.instanceId)
    if (baseUrl === null) {
      return { ok: false, code: 'no-credential' }
    }
    const token = deps.readReadToken(request.instanceId)
    if (token === null) {
      return { ok: false, code: 'no-credential' }
    }
    const head = await createGitlabApiReader(
      {
        http: deps.http,
        readToken: () => token,
        readConfigRevision: deps.readConfigRevision,
        signal
      },
      {
        baseUrl,
        projectId: request.projectId,
        expectedConfigRevision: deps.expectedConfigRevision
      }
    ).getRepositoryBranchHead(request.branch)
    return head.ok ? { ok: true, sha: head.data.sha } : { ok: false, code: head.code }
  }
}
