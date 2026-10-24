import type { GitlabDiffFile } from './forge-inbox-gitlab-api-schemas'
import {
  FORGE_PATCH_MAX_OPERATIONS,
  FORGE_PATCH_MAX_TOTAL_BYTES,
  forgePatchPathCollisionKey,
  isForgePatchOperationPathAllowed,
  sha256OfContent
} from './forge-inbox-patch-draft'
import type { ForgePatchSource } from './forge-inbox-patch-tree'

export type ForgePatchContextEntry =
  | { path: string; kind: 'file'; content: string; sha256: string }
  | { path: string; kind: 'missing' }

export type ForgePatchContextFailure =
  | 'context-duplicate'
  | 'context-paths'
  | 'context-unsupported'
  | 'context-unavailable'
  | 'context-too-large'

export type ForgePatchContextResult =
  | { ok: true; entries: ForgePatchContextEntry[] }
  | { ok: false; reason: ForgePatchContextFailure }

/** Splits read entries into what the model may create and what it may update or delete. */
export function forgePatchPathSets(entries: readonly ForgePatchContextEntry[]): {
  present: Set<string>
  missing: Set<string>
  baseHashes: Map<string, string>
} {
  const present = new Set<string>()
  const missing = new Set<string>()
  const baseHashes = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'missing') {
      missing.add(entry.path)
    } else {
      present.add(entry.path)
      baseHashes.set(entry.path, entry.sha256)
    }
  }
  return { present, missing, baseHashes }
}

/** A deleted path no longer exists, so its current name is the one it was removed from. */
function currentDiffPath(diff: GitlabDiffFile): string {
  return diff.deleted_file ? diff.old_path : diff.new_path
}

/** Null for any diff set whose paths are not exactly 1..32 portable operation targets. */
export function forgePatchPathsFromDiffs(diffs: readonly GitlabDiffFile[]): string[] | null {
  const unique = new Map<string, string>()
  for (const diff of diffs) {
    const path = currentDiffPath(diff)
    if (!isForgePatchOperationPathAllowed(path)) {
      return null
    }
    const key = forgePatchPathCollisionKey(path)
    if (!unique.has(key)) {
      unique.set(key, path)
    }
  }
  if (unique.size === 0 || unique.size > FORGE_PATCH_MAX_OPERATIONS) {
    return null
  }
  return [...unique.values()]
}

/** Reads every requested path at the pinned base; an unproven absence is never assumed missing. */
export async function readForgePatchContext(input: {
  source: ForgePatchSource
  paths: readonly string[]
}): Promise<ForgePatchContextResult> {
  const { paths } = input
  if (new Set(paths).size !== paths.length) {
    return { ok: false, reason: 'context-duplicate' }
  }
  if (paths.length > FORGE_PATCH_MAX_OPERATIONS) {
    return { ok: false, reason: 'context-paths' }
  }
  const keys = new Set<string>()
  for (const path of paths) {
    if (!isForgePatchOperationPathAllowed(path)) {
      return { ok: false, reason: 'context-paths' }
    }
    const key = forgePatchPathCollisionKey(path)
    if (keys.has(key)) {
      return { ok: false, reason: 'context-paths' }
    }
    keys.add(key)
  }

  const entries: ForgePatchContextEntry[] = []
  let totalBytes = 0
  for (const path of paths) {
    const content = await input.source.readPath(path)
    if (content.kind === 'unsupported') {
      return { ok: false, reason: 'context-unsupported' }
    }
    if (content.kind === 'unavailable') {
      return { ok: false, reason: 'context-unavailable' }
    }
    if (content.kind === 'missing') {
      entries.push({ path, kind: 'missing' })
      continue
    }
    totalBytes += Buffer.byteLength(content.content, 'utf8')
    if (totalBytes > FORGE_PATCH_MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'context-too-large' }
    }
    entries.push({
      path,
      kind: 'file',
      content: content.content,
      sha256: sha256OfContent(content.content)
    })
  }
  return { ok: true, entries }
}
