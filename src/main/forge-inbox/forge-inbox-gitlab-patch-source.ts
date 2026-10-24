import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import { createForgeGitBlob, isForgeGitSha1 } from './forge-inbox-git-objects'
import {
  FORGE_PATCH_MAX_FILE_BYTES,
  forgePatchPathCollisionKey,
  isForgePatchPathAllowed
} from './forge-inbox-patch-draft'
import type { ForgePatchPathContent, ForgePatchSource } from './forge-inbox-patch-tree'

export type GitlabPatchSourceDeps = {
  reader: Pick<GitlabApiReader, 'listRepositoryTree' | 'getRepositoryFile'>
  /** The approved base commit; every read is pinned to it, never to a moving branch. */
  ref: string
}

/**
 * Reads the reviewed base through the restricted GitLab API. A truncated tree is treated as
 * unavailable because absence of a path can no longer be proven from it.
 */
export function createGitlabPatchSource(deps: GitlabPatchSourceDeps): ForgePatchSource {
  let listing: Promise<GitlabTreeEntry[] | null> | null = null

  function entries(): Promise<GitlabTreeEntry[] | null> {
    listing ??= (async () => {
      const response = await deps.reader.listRepositoryTree(deps.ref)
      return response.ok && response.complete ? response.data : null
    })()
    return listing
  }

  return {
    async readPath(path): Promise<ForgePatchPathContent> {
      if (!isForgeGitSha1(deps.ref) || !isForgePatchPathAllowed(path)) {
        return { kind: 'unavailable' }
      }
      const tree = await entries()
      if (tree === null) {
        return { kind: 'unavailable' }
      }
      const matches = tree.filter((entry) => entry.path === path)
      if (matches.length > 1) {
        return { kind: 'unsupported', why: 'non-blob' }
      }
      const entry = matches[0]
      if (entry === undefined) {
        const key = forgePatchPathCollisionKey(path)
        const aliased = tree.some((candidate) => forgePatchPathCollisionKey(candidate.path) === key)
        return aliased ? { kind: 'unavailable' } : { kind: 'missing' }
      }
      if (entry.type === 'commit' || entry.mode === '160000') {
        return { kind: 'unsupported', why: 'submodule' }
      }
      if (entry.mode === '120000') {
        return { kind: 'unsupported', why: 'link' }
      }
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        return { kind: 'unsupported', why: 'non-blob' }
      }
      if (!isForgeGitSha1(entry.id)) {
        return { kind: 'unavailable' }
      }
      const response = await deps.reader.getRepositoryFile(deps.ref, path)
      if (!response.ok || !response.complete) {
        return { kind: 'unavailable' }
      }
      if (response.data.includes('\u0000')) {
        return { kind: 'unsupported', why: 'binary' }
      }
      if (Buffer.byteLength(response.data, 'utf8') > FORGE_PATCH_MAX_FILE_BYTES) {
        return { kind: 'unsupported', why: 'too-large' }
      }
      const blob = createForgeGitBlob(response.data)
      if (blob.content.toString('utf8') !== response.data) {
        return { kind: 'unsupported', why: 'binary' }
      }
      if (blob.oid !== entry.id) {
        return { kind: 'unavailable' }
      }
      return { kind: 'file', content: response.data }
    }
  }
}
