import type { MainHttpClient } from '../network/http-client'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import type { ForgeCommentHead, ForgeCommentHeadReader } from './forge-inbox-comment-proposal'
import type {
  ForgeCommentMarkerLookup,
  ForgeCommentNoteFinder,
  ForgeCommentPoster
} from './forge-inbox-comment-publish'
import { createGitlabApiReader } from './forge-inbox-gitlab-api-client'
import {
  createGitlabApiWriteRequester,
  type GitlabApiDeps,
  type GitlabApiErrorCode,
  type GitlabApiScope
} from './forge-inbox-gitlab-api-request'

export type GitlabCommentPublisherDeps = {
  http: Pick<MainHttpClient, 'fetch'>
  /** api-write: only this adapter may invoke it, and only for an already-approved comment. */
  readWriteToken: (instanceId: string) => string | null
  /** api-read: reconciliation never needs the write credential. */
  readReadToken: (instanceId: string) => string | null
  readConfigRevision: () => number
  expectedConfigRevision: number
  resolveInstanceBaseUrl: (instanceId: string) => string | null
}

/** Codes that prove GitLab rejected the request before writing anything. */
const NOT_WRITTEN: ReadonlySet<GitlabApiErrorCode> = new Set([
  'unauthorized',
  'forbidden',
  'not-found',
  'no-credential',
  'stale-config',
  'request-too-large'
])

/**
 * The host-side comment ports. Read and write credentials stay in the host; nothing here accepts a
 * caller-provided URL, token or project — only the target the approval was bound to.
 */
export function createGitlabCommentPublisher(deps: GitlabCommentPublisherDeps): {
  post: ForgeCommentPoster
  findNotes: ForgeCommentNoteFinder
  readHead: ForgeCommentHeadReader
} {
  function scopeOf(
    target: ForgeCommentTarget
  ): { ok: true; scope: GitlabApiScope } | { ok: false; reason: 'bad-target' | 'no-instance' } {
    if (!Number.isSafeInteger(target.iid) || target.iid <= 0) {
      return { ok: false, reason: 'bad-target' }
    }
    const baseUrl = deps.resolveInstanceBaseUrl(target.instanceId)
    if (baseUrl === null) {
      return { ok: false, reason: 'no-instance' }
    }
    return {
      ok: true,
      scope: {
        baseUrl,
        projectId: target.projectId,
        expectedConfigRevision: deps.expectedConfigRevision
      }
    }
  }

  function apiDeps(token: string, signal: AbortSignal): GitlabApiDeps {
    return {
      http: deps.http,
      readToken: () => token,
      readConfigRevision: deps.readConfigRevision,
      signal
    }
  }

  return {
    async post(request, signal) {
      const located = scopeOf(request.target)
      if (!located.ok) {
        return located.reason === 'bad-target'
          ? { ok: false, code: 'bad-response', mayHaveLanded: false }
          : { ok: false, code: 'no-credential', mayHaveLanded: false }
      }
      const token = deps.readWriteToken(request.target.instanceId)
      if (token === null) {
        return { ok: false, code: 'no-credential', mayHaveLanded: false }
      }
      const response = await createGitlabApiWriteRequester(
        apiDeps(token, signal),
        located.scope
      ).post(`/${collectionOf(request.target)}/${request.target.iid}/notes`, {
        body: request.body
      })
      if (response.ok) {
        return { ok: true, noteId: noteIdOf(response.json) }
      }
      return { ok: false, code: response.code, mayHaveLanded: !NOT_WRITTEN.has(response.code) }
    },

    /** Only a merge request has a head an approval can be bound to; an issue draft carries none. */
    async readHead(target, signal): Promise<ForgeCommentHead> {
      if (target.kind !== 'merge_request') {
        return { ok: false, code: 'bad-response' }
      }
      const located = scopeOf(target)
      if (!located.ok) {
        return {
          ok: false,
          code: located.reason === 'bad-target' ? 'bad-response' : 'no-credential'
        }
      }
      const token = deps.readReadToken(target.instanceId)
      if (token === null) {
        return { ok: false, code: 'no-credential' }
      }
      const mergeRequest = await createGitlabApiReader(
        apiDeps(token, signal),
        located.scope
      ).getMergeRequest(target.iid)
      if (!mergeRequest.ok) {
        return { ok: false, code: mergeRequest.code }
      }
      const sha = mergeRequest.data.sha ?? mergeRequest.data.diff_refs?.head_sha ?? null
      return sha === null ? { ok: false, code: 'bad-response' } : { ok: true, sha }
    },

    async findNotes(request, signal) {
      const located = scopeOf(request.target)
      if (!located.ok) {
        return {
          ok: false,
          code: located.reason === 'bad-target' ? 'bad-response' : 'no-credential'
        }
      }
      const token = deps.readReadToken(request.target.instanceId)
      if (token === null) {
        return { ok: false, code: 'no-credential' }
      }
      const reader = createGitlabApiReader(apiDeps(token, signal), located.scope)
      const notes =
        request.target.kind === 'merge_request'
          ? await reader.listMergeRequestNotes(request.target.iid)
          : await reader.listIssueNotes(request.target.iid)
      if (!notes.ok) {
        return { ok: false, code: notes.code }
      }
      return {
        ok: true,
        noteIds: notes.data
          .filter((note) => note.body.includes(request.marker))
          .map((note) => note.id),
        complete: notes.complete
      } satisfies ForgeCommentMarkerLookup
    }
  }
}

function collectionOf(target: ForgeCommentTarget): 'merge_requests' | 'issues' {
  return target.kind === 'merge_request' ? 'merge_requests' : 'issues'
}

/** The official create-note response carries the new id; an unreadable one still means it landed. */
function noteIdOf(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) {
    return null
  }
  const id = Reflect.get(json, 'id')
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
}
