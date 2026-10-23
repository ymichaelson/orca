import { isForgePatchPathAllowed, type ForgePatchDraft } from './forge-inbox-patch-draft'
import {
  createForgeGitBlob,
  createForgeGitTree,
  isForgeGitSha1,
  type ForgeGitObject,
  type ForgeGitTreeEntry
} from './forge-inbox-git-objects'

export const FORGE_PUSH_MAX_ENTRIES = 20_000
export const FORGE_PUSH_MAX_DEPTH = 64

/** One entry of the pinned commit's recursive tree listing. */
export type ForgePushBaseEntry = {
  path: string
  type: 'blob' | 'tree' | 'commit'
  mode: string
  id: string
}

export type ForgePushTreeFailure =
  | 'base-too-large'
  | 'base-entry-invalid'
  | 'base-unsupported-object'
  | 'base-unsupported-hash'
  | 'operation-target-conflict'
  | 'tree-invalid'
  | 'path-too-deep'

export type ForgePushTreeResult =
  | { ok: true; rootTree: string; objects: ForgeGitObject[] }
  | { ok: false; reason: ForgePushTreeFailure }

type BlobNode = { kind: 'blob'; mode: '100644' | '100755'; oid: string }
type TreeMark = { kind: 'tree'; oid: string | null }

type Model = {
  nodes: Map<string, BlobNode | TreeMark>
  /** Direct child names per directory, used to rebuild dirty trees only. */
  names: Map<string, Set<string>>
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function attach(model: Model, path: string): void {
  const parent = parentOf(path)
  let names = model.names.get(parent)
  if (!names) {
    names = new Set()
    model.names.set(parent, names)
  }
  names.add(nameOf(path))
}

function ensureDirectories(model: Model, path: string): void {
  let current = parentOf(path)
  while (current !== '') {
    if (!model.nodes.has(current)) {
      model.nodes.set(current, { kind: 'tree', oid: null })
    }
    attach(model, current)
    current = parentOf(current)
  }
}

function readBaseEntries(
  entries: readonly ForgePushBaseEntry[],
  model: Model
): ForgePushTreeFailure | null {
  if (entries.length > FORGE_PUSH_MAX_ENTRIES) {
    return 'base-too-large'
  }
  for (const entry of entries) {
    if (!isForgePatchPathAllowed(entry.path)) {
      return 'base-entry-invalid'
    }
    if (entry.path.split('/').length > FORGE_PUSH_MAX_DEPTH) {
      return 'path-too-deep'
    }
    if (model.nodes.has(entry.path)) {
      return 'base-entry-invalid'
    }
    if (entry.type === 'commit' || entry.mode === '160000') {
      return 'base-unsupported-object'
    }
    if (entry.type === 'tree') {
      if (entry.mode !== '040000' && entry.mode !== '40000') {
        return 'base-entry-invalid'
      }
      if (!isForgeGitSha1(entry.id)) {
        return 'base-unsupported-hash'
      }
      model.nodes.set(entry.path, { kind: 'tree', oid: entry.id })
      ensureDirectories(model, entry.path)
      attach(model, entry.path)
      continue
    }
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      return 'base-unsupported-object'
    }
    if (!isForgeGitSha1(entry.id)) {
      return 'base-unsupported-hash'
    }
    model.nodes.set(entry.path, { kind: 'blob', mode: entry.mode, oid: entry.id })
    ensureDirectories(model, entry.path)
    attach(model, entry.path)
  }
  for (const [path, node] of model.nodes) {
    if (node.kind === 'blob' && model.names.has(path)) {
      return 'base-entry-invalid'
    }
  }
  return null
}

function applyOperations(
  draft: ForgePatchDraft,
  model: Model,
  objects: Map<string, ForgeGitObject>
): ForgePushTreeFailure | null {
  for (const operation of draft.operations) {
    const current = model.nodes.get(operation.path)
    if (operation.op === 'create') {
      if (current !== undefined) {
        return 'operation-target-conflict'
      }
    } else if (current === undefined || current.kind !== 'blob') {
      return 'operation-target-conflict'
    }
    ensureDirectories(model, operation.path)
    if (operation.op === 'delete') {
      model.nodes.delete(operation.path)
      model.names.get(parentOf(operation.path))?.delete(nameOf(operation.path))
      continue
    }
    const blob = createForgeGitBlob(operation.content)
    objects.set(blob.oid, blob)
    const mode = current !== undefined && current.kind === 'blob' ? current.mode : '100644'
    model.nodes.set(operation.path, { kind: 'blob', mode, oid: blob.oid })
    attach(model, operation.path)
  }
  return null
}

function dirtyDirectories(draft: ForgePatchDraft): Set<string> {
  const dirty = new Set<string>([''])
  for (const operation of draft.operations) {
    let current = parentOf(operation.path)
    while (true) {
      dirty.add(current)
      if (current === '') {
        break
      }
      current = parentOf(current)
    }
  }
  return dirty
}

/**
 * Rebuilds only the trees on the path from each change to the root. Untouched subtrees keep the
 * object ids the pinned commit published, so no other blob has to be downloaded or trusted; the
 * remote's own connectivity check rejects anything we could not reproduce faithfully.
 */
export function buildForgePushTree(input: {
  entries: readonly ForgePushBaseEntry[]
  draft: ForgePatchDraft
}): ForgePushTreeResult {
  return rebuild(input.entries, input.draft)
}

/** The pinned commit's own root tree, used to prove an API listing reproduces the approved head. */
export function buildForgePushBaseTree(
  entries: readonly ForgePushBaseEntry[]
):
  | { ok: true; rootTree: string; objects: ForgeGitObject[] }
  | { ok: false; reason: ForgePushTreeFailure } {
  return rebuild(entries, null)
}

function rebuild(
  entries: readonly ForgePushBaseEntry[],
  draft: ForgePatchDraft | null
): ForgePushTreeResult {
  const model: Model = { nodes: new Map(), names: new Map() }
  const baseProblem = readBaseEntries(entries, model)
  if (baseProblem !== null) {
    return { ok: false, reason: baseProblem }
  }
  const objects = new Map<string, ForgeGitObject>()
  const operationProblem = draft === null ? null : applyOperations(draft, model, objects)
  if (operationProblem !== null) {
    return { ok: false, reason: operationProblem }
  }

  const dirty = draft === null ? new Set<string>() : dirtyDirectories(draft)
  const built = new Map<string, string | null>()
  const build = (path: string): string | null => {
    if (built.has(path)) {
      return built.get(path) ?? null
    }
    const node = model.nodes.get(path)
    if (path !== '' && node?.kind === 'tree' && node.oid !== null && !dirty.has(path)) {
      built.set(path, node.oid)
      return node.oid
    }
    const treeEntries: ForgeGitTreeEntry[] = []
    for (const name of model.names.get(path) ?? []) {
      const childPath = path === '' ? name : `${path}/${name}`
      const child = model.nodes.get(childPath)
      if (child === undefined) {
        continue
      }
      const oid = child.kind === 'blob' ? child.oid : build(childPath)
      if (oid === null) {
        continue
      }
      treeEntries.push({
        mode: child.kind === 'blob' ? child.mode : '40000',
        name,
        oid
      })
    }
    // Git tracks no empty directories, so an emptied directory disappears from its parent.
    if (path !== '' && treeEntries.length === 0) {
      built.set(path, null)
      return null
    }
    const tree = createForgeGitTree(treeEntries)
    built.set(path, tree?.oid ?? null)
    if (tree !== null) {
      objects.set(tree.oid, tree)
    }
    return tree?.oid ?? null
  }

  const rootTree = build('')
  return rootTree === null
    ? { ok: false, reason: 'tree-invalid' }
    : { ok: true, rootTree, objects: [...objects.values()] }
}
