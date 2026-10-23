import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import {
  createForgeGitCommit,
  isForgeGitSha1,
  type ForgeGitIdentity,
  type ForgeGitObject
} from './forge-inbox-git-objects'
import { buildForgePushBaseTree, type ForgePushBaseEntry } from './forge-inbox-git-push-tree'

export type ForgePushBaseReader = Pick<
  GitlabApiReader,
  'listRepositoryTree' | 'getRepositoryCommit'
>

export type ForgePushBase = {
  /** The approved head reconstructed byte for byte; git needs it locally to stop at the boundary. */
  commit: ForgeGitObject
  rootTree: string
  entries: GitlabTreeEntry[]
}

export type ForgePushBaseFailure = 'base-unavailable' | 'base-unsupported' | 'base-unverified'

export type ForgePushBaseResult =
  | { ok: true; base: ForgePushBase }
  | { ok: false; reason: ForgePushBaseFailure }

const GITLAB_DATE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):?(\d{2}))$/

/** GitLab returns ISO dates; git needs epoch seconds and the original offset, never the host zone. */
export function parseForgeGitlabCommitDate(
  value: string
): { timeSeconds: number; timezone: string } | null {
  const match = GITLAB_DATE.exec(value)
  if (!match) {
    return null
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    return null
  }
  let timezone = '+0000'
  if (match[2] !== 'Z') {
    const hours = Number(match[4])
    const minutes = Number(match[5])
    if (hours > 23 || minutes > 59) {
      return null
    }
    timezone = `${match[3]}${match[4]}${match[5]}`
  }
  return { timeSeconds: Math.floor(milliseconds / 1000), timezone }
}

function identity(name: string, email: string, date: string): ForgeGitIdentity | null {
  const parsed = parseForgeGitlabCommitDate(date)
  return parsed === null ? null : { name, email, ...parsed }
}

/**
 * Reconstructs the approved head commit from restricted API metadata. Anything the serializer
 * cannot reproduce exactly (signatures, extra headers, unusual identities) simply fails to hash
 * to the approved id and is reported as such — there is no unverified fallback.
 */
export async function readForgePushBase(
  deps: { reader: ForgePushBaseReader; expectedHeadSha: string },
  signal: AbortSignal
): Promise<ForgePushBaseResult> {
  if (!isForgeGitSha1(deps.expectedHeadSha)) {
    return { ok: false, reason: 'base-unsupported' }
  }
  const [listing, response] = await Promise.all([
    deps.reader.listRepositoryTree(deps.expectedHeadSha),
    deps.reader.getRepositoryCommit(deps.expectedHeadSha)
  ])
  if (signal.aborted) {
    return { ok: false, reason: 'base-unavailable' }
  }
  if (!listing.ok || !listing.complete || !response.ok) {
    return { ok: false, reason: 'base-unavailable' }
  }
  const metadata = response.data
  const author = identity(metadata.author_name, metadata.author_email, metadata.authored_date)
  const committer = identity(
    metadata.committer_name,
    metadata.committer_email,
    metadata.committed_date
  )
  if (metadata.id !== deps.expectedHeadSha || author === null || committer === null) {
    return { ok: false, reason: 'base-unverified' }
  }
  const entries: ForgePushBaseEntry[] = listing.data.map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    id: entry.id
  }))
  const tree = buildForgePushBaseTree(entries)
  if (!tree.ok) {
    return { ok: false, reason: 'base-unsupported' }
  }
  const commit = createForgeGitCommit({
    tree: tree.rootTree,
    parents: metadata.parent_ids,
    author,
    committer,
    message: metadata.message
  })
  if (commit === null) {
    return { ok: false, reason: 'base-unsupported' }
  }
  return commit.oid === deps.expectedHeadSha
    ? { ok: true, base: { commit, rootTree: tree.rootTree, entries: listing.data } }
    : { ok: false, reason: 'base-unverified' }
}
