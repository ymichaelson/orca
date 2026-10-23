import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { sha256OfContent, type ForgePatchDraft } from './forge-inbox-patch-draft'

export const FORGE_PATCH_TREE_MAX_FILES = 32
export const FORGE_PATCH_TREE_MAX_BYTES = 1024 * 1024

/** What the pinned commit says about one path the manifest touches. */
export type ForgePatchPathContent =
  | { kind: 'missing' }
  | { kind: 'file'; content: string }
  | { kind: 'unsupported'; why: 'link' | 'submodule' | 'binary' | 'too-large' | 'non-blob' }
  | { kind: 'unavailable' }

export type ForgePatchSource = {
  readPath: (path: string) => Promise<ForgePatchPathContent>
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export type ForgePatchTreeResult =
  | { ok: true; directory: string; written: string[]; removed: string[] }
  | {
      ok: false
      reason:
        | 'base-missing'
        | 'base-unexpected'
        | 'base-mismatch'
        | 'base-unsupported'
        | 'source-unavailable'
        | 'path-unsafe'
        | 'write-failed'
        | 'aborted'
    }

/**
 * Applies the approved manifest to a fresh private directory built from the pinned commit.
 * The caller's project root is never touched, and every source path is refused unless it is a
 * plain blob whose content hashes to the base the owner approved.
 */
export async function applyForgePatchInIsolation(
  deps: { source: ForgePatchSource; parentDirectory: string; signal?: AbortSignal },
  draft: ForgePatchDraft
): Promise<ForgePatchTreeResult> {
  if (draft.operations.length > FORGE_PATCH_TREE_MAX_FILES) {
    return { ok: false, reason: 'base-unsupported' }
  }
  let bytes = 0
  for (const operation of draft.operations) {
    const base = await deps.source.readPath(operation.path)
    if (base.kind === 'unavailable') {
      return { ok: false, reason: 'source-unavailable' }
    }
    if (base.kind === 'unsupported') {
      return { ok: false, reason: 'base-unsupported' }
    }
    if (operation.op === 'create') {
      if (base.kind !== 'missing') {
        return { ok: false, reason: 'base-unexpected' }
      }
      continue
    }
    if (base.kind === 'missing') {
      return { ok: false, reason: 'base-missing' }
    }
    if (sha256OfContent(base.content) !== operation.baseSha256) {
      return { ok: false, reason: 'base-mismatch' }
    }
    bytes += Buffer.byteLength(base.content, 'utf8')
  }
  bytes += draft.operations.reduce(
    (total, operation) =>
      total + ('content' in operation ? Buffer.byteLength(operation.content, 'utf8') : 0),
    0
  )
  if (bytes > FORGE_PATCH_TREE_MAX_BYTES) {
    return { ok: false, reason: 'base-unsupported' }
  }
  if (deps.signal?.aborted) {
    return { ok: false, reason: 'aborted' }
  }

  const root = resolve(deps.parentDirectory)
  let directory: string
  try {
    // mkdtemp creates the directory with owner-only permissions.
    directory = mkdtempSync(join(root, 'forge-patch-'))
  } catch {
    return { ok: false, reason: 'write-failed' }
  }

  const written: string[] = []
  const removed: string[] = []
  for (const operation of draft.operations) {
    if (deps.signal?.aborted) {
      rmSync(directory, { recursive: true, force: true })
      return { ok: false, reason: 'aborted' }
    }
    const target = resolve(directory, operation.path)
    if (target !== directory && !target.startsWith(`${directory}${sep}`)) {
      rmSync(directory, { recursive: true, force: true })
      return { ok: false, reason: 'path-unsafe' }
    }
    try {
      if (operation.op === 'delete') {
        try {
          unlinkSync(target)
        } catch (error) {
          // A fresh tree holds only the post-patch state, so the file is usually already absent.
          if (!isMissingFile(error)) {
            throw error
          }
        }
        removed.push(operation.path)
        continue
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, operation.content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: operation.op === 'create' ? 'wx' : 'w'
      })
      written.push(operation.path)
    } catch {
      rmSync(directory, { recursive: true, force: true })
      return { ok: false, reason: 'write-failed' }
    }
  }
  return { ok: true, directory, written, removed }
}
