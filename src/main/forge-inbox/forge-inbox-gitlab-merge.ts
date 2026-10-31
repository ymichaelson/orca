import { z } from 'zod'
import { createGitlabProjectApi, GitlabProjectApiError } from '../gitlab/gitlab-project-api'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import type { GitlabBindingCommentScope } from './forge-inbox-gitlab-binding-comment'
import type { GitlabCommentPublisherDeps } from './forge-inbox-gitlab-comment-publish'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'
import {
  createGitlabApiWriteRequester,
  type GitlabApiErrorCode
} from './forge-inbox-gitlab-api-request'

export type ForgeMergeFailureCode =
  | 'not-open'
  | 'draft'
  | 'head-moved'
  | 'not-mergeable'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'bad-response'
  | 'network'
  | 'stale-config'
  | 'no-credential'
  | 'cancelled'

/** `mayHaveLanded` is true whenever the answer cannot prove GitLab did not merge. */
export type ForgeMergeOutcome =
  | { ok: true }
  | { ok: false; code: ForgeMergeFailureCode; mayHaveLanded: boolean }

export type ForgeMergePort = {
  merge(
    target: ForgeCommentTarget,
    expectedHeadSha: string,
    signal: AbortSignal
  ): Promise<ForgeMergeOutcome>
}

/** Codes that prove GitLab rejected the merge before writing anything. */
const NOT_WRITTEN: ReadonlySet<string> = new Set([
  'unauthorized',
  'forbidden',
  'not-found',
  'no-credential',
  'stale-config',
  'request-too-large',
  'conflict',
  'rejected'
])

const READ_CODES: Readonly<Record<string, ForgeMergeFailureCode>> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'not-found': 'not-found',
  'rate-limited': 'rate-limited',
  'bad-response': 'bad-response',
  network: 'network',
  'stale-config': 'stale-config',
  'no-credential': 'no-credential'
}

type MergeableState = {
  state: string
  draft: boolean
  sha: string | null
  diffRefsHead: string | null
}

/** GitLab refuses a merge for any of these, so the host refuses first and says which one. */
function blockedBy(state: MergeableState, expectedHeadSha: string): ForgeMergeFailureCode | null {
  if (state.state !== 'opened') {
    return 'not-open'
  }
  if (state.draft) {
    return 'draft'
  }
  const head = state.sha ?? state.diffRefsHead
  return head === expectedHeadSha ? null : 'head-moved'
}

function writeCode(code: GitlabApiErrorCode): ForgeMergeFailureCode {
  if (code === 'conflict') {
    return 'head-moved'
  }
  return code === 'rejected' || code === 'too-large'
    ? 'not-mergeable'
    : (READ_CODES[code] ?? 'bad-response')
}

/**
 * The instance-credential merge path. The read credential proves the reviewed head is still the
 * head, and only then does the write credential send the same SHA as GitLab's own guard.
 */
export function createGitlabMergePort(deps: GitlabCommentPublisherDeps): ForgeMergePort {
  return {
    async merge(target, expectedHeadSha, signal) {
      if (target.kind !== 'merge_request' || !Number.isSafeInteger(target.iid) || target.iid <= 0) {
        return { ok: false, code: 'bad-response', mayHaveLanded: false }
      }
      const baseUrl = deps.resolveInstanceBaseUrl(target.instanceId)
      if (baseUrl === null) {
        return { ok: false, code: 'no-credential', mayHaveLanded: false }
      }
      const scope = {
        baseUrl,
        projectId: target.projectId,
        expectedConfigRevision: deps.expectedConfigRevision
      }
      const readToken = deps.readReadToken(target.instanceId)
      if (readToken === null) {
        return { ok: false, code: 'no-credential', mayHaveLanded: false }
      }
      const read = await createGitlabApiReader(
        {
          http: deps.http,
          readToken: () => readToken,
          readConfigRevision: deps.readConfigRevision,
          signal
        },
        scope
      ).getMergeRequest(target.iid)
      if (!read.ok) {
        return { ok: false, code: READ_CODES[read.code] ?? 'bad-response', mayHaveLanded: false }
      }
      const blocked = blockedBy(
        {
          state: read.data.state,
          draft: read.data.draft === true,
          sha: read.data.sha ?? null,
          diffRefsHead: read.data.diff_refs?.head_sha ?? null
        },
        expectedHeadSha
      )
      if (blocked !== null) {
        return { ok: false, code: blocked, mayHaveLanded: false }
      }
      const writeToken = deps.readWriteToken(target.instanceId)
      if (writeToken === null) {
        return { ok: false, code: 'no-credential', mayHaveLanded: false }
      }
      const written = await createGitlabApiWriteRequester(
        {
          http: deps.http,
          readToken: () => writeToken,
          readConfigRevision: deps.readConfigRevision,
          signal
        },
        scope
      ).put(`/merge_requests/${target.iid}/merge`, { sha: expectedHeadSha })
      if (written.ok) {
        return { ok: true }
      }
      return {
        ok: false,
        code: signal.aborted ? 'cancelled' : writeCode(written.code),
        mayHaveLanded: !NOT_WRITTEN.has(written.code)
      }
    }
  }
}

const bindingMergeStateSchema = z.object({
  state: z.string(),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  sha: z.string().nullish(),
  diff_refs: z.object({ head_sha: z.string() }).nullish()
})

const BINDING_CODES: Readonly<Record<string, ForgeMergeFailureCode>> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'not-found': 'not-found',
  'rate-limited': 'rate-limited',
  'invalid-request': 'not-mergeable',
  'invalid-config': 'bad-response',
  'callback-blocked': 'bad-response',
  'bad-response': 'bad-response',
  network: 'network',
  'unknown-outcome': 'network',
  'too-many-hooks': 'bad-response',
  'event-configuration-rejected': 'bad-response',
  'ownership-conflict': 'bad-response'
}

/** The binding owns the destination and glab owns the credential, so nothing here takes a token. */
export function createGitlabBindingMergePort(scope: GitlabBindingCommentScope): ForgeMergePort {
  const api = createGitlabProjectApi(scope)
  return {
    async merge(target, expectedHeadSha, signal) {
      if (target.kind !== 'merge_request' || !Number.isSafeInteger(target.iid) || target.iid <= 0) {
        return { ok: false, code: 'bad-response', mayHaveLanded: false }
      }
      try {
        const parsed = bindingMergeStateSchema.safeParse(
          await api('GET', `merge_requests/${target.iid}`, signal)
        )
        if (!parsed.success) {
          return { ok: false, code: 'bad-response', mayHaveLanded: false }
        }
        const blocked = blockedBy(
          {
            state: parsed.data.state,
            draft: (parsed.data.draft ?? parsed.data.work_in_progress) === true,
            sha: parsed.data.sha ?? null,
            diffRefsHead: parsed.data.diff_refs?.head_sha ?? null
          },
          expectedHeadSha
        )
        if (blocked !== null) {
          return { ok: false, code: blocked, mayHaveLanded: false }
        }
      } catch (error) {
        return {
          ok: false,
          code: signal.aborted ? 'cancelled' : projectCode(error),
          mayHaveLanded: false
        }
      }
      try {
        await api('PUT', `merge_requests/${target.iid}/merge`, signal, { sha: expectedHeadSha })
        return { ok: true }
      } catch (error) {
        const code = signal.aborted ? 'cancelled' : projectCode(error)
        return { ok: false, code, mayHaveLanded: !NOT_WRITTEN.has(code) && code !== 'cancelled' }
      }
    }
  }
}

function projectCode(error: unknown): ForgeMergeFailureCode {
  const code = error instanceof GitlabProjectApiError ? error.code : 'bad-response'
  if (code === 'conflict') {
    return 'head-moved'
  }
  if (code === 'aborted') {
    return 'cancelled'
  }
  return BINDING_CODES[code] ?? 'bad-response'
}
