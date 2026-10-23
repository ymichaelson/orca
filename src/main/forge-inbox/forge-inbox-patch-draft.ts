import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from './forge-inbox-canonical-json'

export const FORGE_PATCH_MAX_OPERATIONS = 32
export const FORGE_PATCH_MAX_PATH_BYTES = 1024
export const FORGE_PATCH_MAX_FILE_BYTES = 256 * 1024
export const FORGE_PATCH_MAX_TOTAL_BYTES = 1024 * 1024

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const HASH = /^[0-9a-f]{64}$/
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}
const ITEM_IDENTITY = z.string().min(1).max(512)

export type ForgePatchTarget = { instanceId: string; projectId: string }

export type ForgePatchFile = {
  /** The full new UTF-8 content; never a patch fragment. */
  content: string
  /** sha256 of the content, so approval binds what was displayed and what will be written. */
  resultSha256: string
}

export type ForgePatchOperation =
  | ({ op: 'create'; path: string } & ForgePatchFile)
  | ({ op: 'update'; path: string; baseSha256: string } & ForgePatchFile)
  | { op: 'delete'; path: string; baseSha256: string }

export type ForgePatchDraft = {
  kind: 'patch'
  target: ForgePatchTarget
  /** The branch head the manifest was produced against; approval stales when it moves. */
  baseSha: string
  branch: string
  operations: ForgePatchOperation[]
}

export type ForgePatchDraftFailure =
  | 'target-invalid'
  | 'base-invalid'
  | 'branch-invalid'
  | 'operations-empty'
  | 'operations-too-many'
  | 'operation-invalid'
  | 'path-invalid'
  | 'duplicate-path'
  | 'content-binary'
  | 'content-too-large'
  | 'total-too-large'
  | 'hash-invalid'
  | 'result-hash-mismatch'

export type ForgePatchDraftResult =
  | { ok: true; draft: ForgePatchDraft; hash: string }
  | { ok: false; reason: ForgePatchDraftFailure }

const targetSchema = z.object({ instanceId: ITEM_IDENTITY, projectId: ITEM_IDENTITY }).strict()

const createSchema = z
  .object({
    op: z.literal('create'),
    path: z.string(),
    content: z.string(),
    resultSha256: z.string()
  })
  .strict()
const updateSchema = z
  .object({
    op: z.literal('update'),
    path: z.string(),
    baseSha256: z.string(),
    content: z.string(),
    resultSha256: z.string()
  })
  .strict()
const deleteSchema = z
  .object({ op: z.literal('delete'), path: z.string(), baseSha256: z.string() })
  .strict()
const operationSchema = z.union([createSchema, updateSchema, deleteSchema])

const patchSchema = z
  .object({
    kind: z.literal('patch'),
    target: targetSchema,
    baseSha: z.string(),
    branch: z.string(),
    operations: z.array(operationSchema)
  })
  .strict()

export function sha256OfContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Stable regardless of operation order or key order: the displayed hash is the approved payload. */
export function hashForgePatchDraft(draft: ForgePatchDraft): string {
  return createHash('sha256').update(canonicalJson(draft), 'utf8').digest('hex')
}

export function buildForgePatchDraft(input: {
  target: ForgePatchTarget
  baseSha: string
  branch: string
  operations: ForgePatchOperation[]
}): ForgePatchDraftResult {
  if (!targetSchema.safeParse(input.target).success) {
    return { ok: false, reason: 'target-invalid' }
  }
  if (!SHA.test(input.baseSha)) {
    return { ok: false, reason: 'base-invalid' }
  }
  if (!isForgePatchBranchAllowed(input.branch)) {
    return { ok: false, reason: 'branch-invalid' }
  }
  if (input.operations.length === 0) {
    return { ok: false, reason: 'operations-empty' }
  }
  if (input.operations.length > FORGE_PATCH_MAX_OPERATIONS) {
    return { ok: false, reason: 'operations-too-many' }
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const operation of input.operations) {
    const problem = operationProblem(operation, seen)
    if (problem !== null) {
      return { ok: false, reason: problem }
    }
    seen.add(operation.path.toLowerCase())
    if (operation.op !== 'delete') {
      totalBytes += Buffer.byteLength(operation.content, 'utf8')
    }
  }
  if (totalBytes > FORGE_PATCH_MAX_TOTAL_BYTES) {
    return { ok: false, reason: 'total-too-large' }
  }
  const draft: ForgePatchDraft = {
    kind: 'patch',
    target: { ...input.target },
    baseSha: input.baseSha,
    branch: input.branch,
    operations: [...input.operations].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )
  }
  return { ok: true, draft, hash: hashForgePatchDraft(draft) }
}

/** Null for anything that is not exactly a valid patch manifest: an unknown body is never applied. */
export function parseForgePatchDraft(body: unknown): ForgePatchDraft | null {
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const built = buildForgePatchDraft(parsed.data)
  return built.ok ? built.draft : null
}

function operationProblem(
  operation: ForgePatchOperation,
  seen: ReadonlySet<string>
): ForgePatchDraftFailure | null {
  if (!isForgePatchPathAllowed(operation.path)) {
    return 'path-invalid'
  }
  // Why casefold: two paths differing only in case collide on a case-insensitive checkout.
  if (seen.has(operation.path.toLowerCase())) {
    return 'duplicate-path'
  }
  if (operation.op === 'delete') {
    return HASH.test(operation.baseSha256) ? null : 'hash-invalid'
  }
  if (operation.op === 'update' && !HASH.test(operation.baseSha256)) {
    return 'hash-invalid'
  }
  if (!HASH.test(operation.resultSha256)) {
    return 'hash-invalid'
  }
  if (operation.content.includes('\u0000')) {
    return 'content-binary'
  }
  if (Buffer.byteLength(operation.content, 'utf8') > FORGE_PATCH_MAX_FILE_BYTES) {
    return 'content-too-large'
  }
  return sha256OfContent(operation.content) === operation.resultSha256
    ? null
    : 'result-hash-mismatch'
}

export function isForgePatchPathAllowed(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) {
    return false
  }
  if (Buffer.byteLength(path, 'utf8') > FORGE_PATCH_MAX_PATH_BYTES || hasControlCharacter(path)) {
    return false
  }
  return !path
    .split('/')
    .some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    )
}

function hasForbiddenBranchCharacter(branch: string): boolean {
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)) {
      return true
    }
  }
  return false
}

/** A conservative subset of git-check-ref-format: rejecting a usable branch is safer than allow-listing one. */
export function isForgePatchBranchAllowed(branch: string): boolean {
  if (branch === '' || Buffer.byteLength(branch, 'utf8') > 255) {
    return false
  }
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) {
    return false
  }
  if (branch.endsWith('.') || branch.endsWith('.lock')) {
    return false
  }
  if (branch === '@' || branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return false
  }
  if (hasForbiddenBranchCharacter(branch)) {
    return false
  }
  return !branch
    .split('/')
    .some(
      (segment) =>
        segment === '' ||
        segment.startsWith('.') ||
        segment.endsWith('.') ||
        segment.endsWith('.lock')
    )
}
