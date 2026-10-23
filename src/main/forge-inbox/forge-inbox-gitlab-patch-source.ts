import type { GitlabApiReader } from './forge-inbox-gitlab-api-client'
import type { GitlabTreeEntry } from './forge-inbox-gitlab-api-schemas'
import { FORGE_PATCH_MAX_FILE_BYTES } from './forge-inbox-patch-draft'
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
        return { kind: 'missing' }
      }
      if (entry.type === 'commit' || entry.mode === '160000') {
        return { kind: 'unsupported', why: 'submodule' }
      }
      if (entry.mode === '120000') {
        return { kind: 'unsupported', why: 'link' }
      }
      if (entry.type !== 'blob') {
        return { kind: 'unsupported', why: 'non-blob' }
      }
      const response = await deps.reader.getRepositoryFile(deps.ref, path)
      if (!response.ok) {
        return { kind: 'unavailable' }
      }
      if (response.data.includes('\u0000')) {
        return { kind: 'unsupported', why: 'binary' }
      }
      if (Buffer.byteLength(response.data, 'utf8') > FORGE_PATCH_MAX_FILE_BYTES) {
        return { kind: 'unsupported', why: 'too-large' }
      }
      return { kind: 'file', content: response.data }
    }
  }
}
