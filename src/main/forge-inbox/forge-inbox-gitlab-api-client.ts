import type { z } from 'zod'
import {
  gitlabCommitSchema,
  gitlabDiffFileSchema,
  gitlabIssueSchema,
  gitlabMergeRequestSchema,
  gitlabNoteSchema,
  gitlabPipelineSchema,
  gitlabTreeEntrySchema,
  type GitlabCommit,
  type GitlabDiffFile,
  type GitlabIssue,
  type GitlabMergeRequest,
  type GitlabNote,
  type GitlabPipeline,
  type GitlabTreeEntry
} from './forge-inbox-gitlab-api-schemas'
import {
  createGitlabApiRequester,
  createGitlabApiTextRequester,
  type GitlabApiDeps,
  type GitlabApiRequester,
  type GitlabApiResult,
  type GitlabApiScope
} from './forge-inbox-gitlab-api-request'
import { readBoundedPages } from './forge-inbox-gitlab-api-pages'

export type {
  GitlabApiDeps,
  GitlabApiErrorCode,
  GitlabApiResult,
  GitlabApiScope
} from './forge-inbox-gitlab-api-request'

const NOTES_MAX_PAGES = 5
const NOTES_MAX_BYTES = 2 * 1024 * 1024
const DIFFS_MAX_FILES = 100
const DIFFS_MAX_BYTES = 1024 * 1024
const TREE_MAX_PAGES = 20
const TREE_MAX_ITEMS = 20_000
const TREE_MAX_BYTES = 4 * 1024 * 1024
const PINNED_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FILE_PATH_MAX_BYTES = 4096

export type GitlabApiReader = {
  getMergeRequest(iid: number): Promise<GitlabApiResult<GitlabMergeRequest>>
  getMergeRequestDiffs(iid: number): Promise<GitlabApiResult<GitlabDiffFile[]>>
  /** Walks newest-first and returns chronological order; complete:false means older notes were dropped. */
  listMergeRequestNotes(iid: number): Promise<GitlabApiResult<GitlabNote[]>>
  listIssueNotes(iid: number): Promise<GitlabApiResult<GitlabNote[]>>
  getPipeline(id: number): Promise<GitlabApiResult<GitlabPipeline>>
  getIssue(iid: number): Promise<GitlabApiResult<GitlabIssue>>
  /** The full recursive tree at one pinned commit; incomplete means absence cannot be proven. */
  listRepositoryTree(ref: string): Promise<GitlabApiResult<GitlabTreeEntry[]>>
  getRepositoryFile(ref: string, path: string): Promise<GitlabApiResult<string>>
  /** Commit metadata at one pinned object id, used to reconstruct the object locally. */
  getRepositoryCommit(ref: string): Promise<GitlabApiResult<GitlabCommit>>
}

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

async function getOne<T>(
  requester: GitlabApiRequester,
  id: number,
  path: string,
  schema: z.ZodType<T>
): Promise<GitlabApiResult<T>> {
  if (!isPositiveSafeInteger(id)) {
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

export function createGitlabApiReader(deps: GitlabApiDeps, scope: GitlabApiScope): GitlabApiReader {
  const requester = createGitlabApiRequester(deps, scope)
  const textRequester = createGitlabApiTextRequester(deps, scope)
  return {
    listRepositoryTree(ref) {
      if (!PINNED_REF.test(ref)) {
        return Promise.resolve({ ok: false, code: 'bad-response' })
      }
      return readBoundedPages(
        requester,
        '/repository/tree',
        { ref, recursive: 'true' },
        gitlabTreeEntrySchema,
        (entry) =>
          Buffer.byteLength(entry.path, 'utf8') +
          Buffer.byteLength(entry.id, 'utf8') +
          Buffer.byteLength(entry.name, 'utf8'),
        { maxPages: TREE_MAX_PAGES, maxItems: TREE_MAX_ITEMS, maxBytes: TREE_MAX_BYTES }
      )
    },
    async getRepositoryFile(ref, path) {
      if (
        !PINNED_REF.test(ref) ||
        path === '' ||
        Buffer.byteLength(path, 'utf8') > FILE_PATH_MAX_BYTES
      ) {
        return { ok: false, code: 'bad-response' }
      }
      const response = await textRequester.getText(
        `/repository/files/${encodeURIComponent(path)}/raw`,
        { ref }
      )
      return response.ok ? { ok: true, data: response.text, complete: true } : response
    },
    async getRepositoryCommit(ref) {
      if (!PINNED_REF.test(ref)) {
        return { ok: false, code: 'bad-response' }
      }
      const response = await requester.get(`/repository/commits/${ref}`)
      if (!response.ok) {
        return response
      }
      const parsed = gitlabCommitSchema.safeParse(response.json)
      return parsed.success && parsed.data.id === ref
        ? { ok: true, data: parsed.data, complete: true }
        : { ok: false, code: 'bad-response' }
    },
    getMergeRequest: (iid) =>
      getOne(requester, iid, `/merge_requests/${iid}`, gitlabMergeRequestSchema),
    getPipeline: (id) => getOne(requester, id, `/pipelines/${id}`, gitlabPipelineSchema),
    getIssue: (iid) => getOne(requester, iid, `/issues/${iid}`, gitlabIssueSchema),
    async getMergeRequestDiffs(iid) {
      if (!isPositiveSafeInteger(iid)) {
        return { ok: false, code: 'bad-response' }
      }
      return readBoundedPages(
        requester,
        `/merge_requests/${iid}/diffs`,
        {},
        gitlabDiffFileSchema,
        (file) => Buffer.byteLength(file.diff),
        { maxPages: 1, maxItems: DIFFS_MAX_FILES, maxBytes: DIFFS_MAX_BYTES }
      )
    },
    listMergeRequestNotes: (iid) => listNotes(requester, iid, 'merge_requests'),
    listIssueNotes: (iid) => listNotes(requester, iid, 'issues')
  }
}

async function listNotes(
  requester: GitlabApiRequester,
  iid: number,
  collection: 'merge_requests' | 'issues'
): Promise<GitlabApiResult<GitlabNote[]>> {
  if (!isPositiveSafeInteger(iid)) {
    return { ok: false, code: 'bad-response' }
  }
  const result = await readBoundedPages(
    requester,
    `/${collection}/${iid}/notes`,
    { sort: 'desc', order_by: 'created_at' },
    gitlabNoteSchema,
    (note) => Buffer.byteLength(note.body),
    { maxPages: NOTES_MAX_PAGES, maxItems: Infinity, maxBytes: NOTES_MAX_BYTES }
  )
  return result.ok ? { ...result, data: result.data.toReversed() } : result
}
