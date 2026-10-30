import { z } from 'zod'
import {
  createGitlabProjectApi,
  GitlabProjectApiError,
  type GitlabProjectApiScope
} from '../gitlab/gitlab-project-api'
import type { ForgeCommentTarget } from './forge-inbox-comment-draft'
import type { ForgeCommentHead, ForgeCommentHeadReader } from './forge-inbox-comment-proposal'
import type {
  ForgeCommentMarkerLookup,
  ForgeCommentNoteFinder,
  ForgeCommentPoster
} from './forge-inbox-comment-publish'

const PAGE_SIZE = 100
const MAX_PAGES = 2
const HEAD_SHA = /^[0-9a-f]{40}$/

/** Codes that prove GitLab rejected the request before writing anything. */
const NOT_WRITTEN: ReadonlySet<string> = new Set([
  'unauthorized',
  'forbidden',
  'not-found',
  'no-credential',
  'stale-config',
  'request-too-large'
])

const noteSchema = z.object({ id: z.number().int(), body: z.string() })

const headSchema = z.object({
  sha: z.string().nullable().optional(),
  diff_refs: z.object({ head_sha: z.string() }).nullable().optional()
})

export type GitlabBindingCommentScope = {
  host: string
  projectId: string
  repoPath: string
  exec?: GitlabProjectApiScope['exec']
}

type NotesRead =
  | { ok: true; data: { id: number; body: string }[]; complete: boolean }
  | { ok: false; code: string }

/**
 * The binding is the only destination: the caller's instance, project and host are ignored, and
 * glab supplies the credential, so no token ever reaches an argument.
 */
export function createGitlabBindingCommentPorts(scope: GitlabBindingCommentScope): {
  post: ForgeCommentPoster
  findNotes: ForgeCommentNoteFinder
  readHead: ForgeCommentHeadReader
} {
  const api = createGitlabProjectApi(scope)

  async function readNotes(target: ForgeCommentTarget, signal: AbortSignal): Promise<NotesRead> {
    const notes: { id: number; body: string }[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await api(
        'GET',
        `${collectionOf(target)}/${target.iid}/notes?per_page=${PAGE_SIZE}&page=${page}` +
          '&sort=desc&order_by=created_at',
        signal
      )
      const parsed = z.array(noteSchema).safeParse(response)
      if (!parsed.success) {
        return { ok: false, code: 'bad-response' }
      }
      notes.push(...parsed.data)
      if (parsed.data.length < PAGE_SIZE) {
        return { ok: true, data: notes, complete: true }
      }
    }
    return { ok: true, data: notes, complete: false }
  }

  return {
    async post(request, signal) {
      if (!validTarget(request.target)) {
        return { ok: false, code: 'bad-response', mayHaveLanded: false }
      }
      try {
        const created = await api(
          'POST',
          `${collectionOf(request.target)}/${request.target.iid}/notes`,
          signal,
          { body: request.body }
        )
        return { ok: true, noteId: noteIdOf(created) }
      } catch (error) {
        const code = errorCode(error, 'network')
        return { ok: false, code, mayHaveLanded: !NOT_WRITTEN.has(code) }
      }
    },

    /** Only a merge request has a head an approval can be bound to; an issue draft carries none. */
    async readHead(target, signal): Promise<ForgeCommentHead> {
      if (target.kind !== 'merge_request' || !validTarget(target)) {
        return { ok: false, code: 'bad-response' }
      }
      try {
        return headOf(await api('GET', `merge_requests/${target.iid}`, signal))
      } catch (error) {
        return { ok: false, code: errorCode(error, 'bad-response') }
      }
    },

    async findNotes(request, signal) {
      if (!validTarget(request.target)) {
        return { ok: false, code: 'bad-response' }
      }
      try {
        const notes = await readNotes(request.target, signal)
        if (!notes.ok) {
          return notes
        }
        return {
          ok: true,
          noteIds: notes.data
            .filter((note) => note.body.includes(request.marker))
            .map((note) => note.id),
          complete: notes.complete
        } satisfies ForgeCommentMarkerLookup
      } catch (error) {
        return { ok: false, code: errorCode(error, 'bad-response') }
      }
    }
  }
}

function validTarget(target: ForgeCommentTarget): boolean {
  return (
    (target.kind === 'merge_request' || target.kind === 'issue') &&
    Number.isSafeInteger(target.iid) &&
    target.iid > 0
  )
}

function collectionOf(target: ForgeCommentTarget): 'merge_requests' | 'issues' {
  return target.kind === 'merge_request' ? 'merge_requests' : 'issues'
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof GitlabProjectApiError ? error.code : fallback
}

function headOf(value: unknown): ForgeCommentHead {
  const parsed = headSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, code: 'bad-response' }
  }
  const sha = parsed.data.diff_refs?.head_sha ?? parsed.data.sha ?? null
  return sha !== null && HEAD_SHA.test(sha)
    ? { ok: true, sha }
    : { ok: false, code: 'bad-response' }
}

/** The official create-note response carries the new id; an unreadable one still means it landed. */
function noteIdOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const id = Reflect.get(value, 'id')
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
}
