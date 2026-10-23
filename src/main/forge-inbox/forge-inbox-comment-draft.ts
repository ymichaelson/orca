import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from './forge-inbox-canonical-json'

/** Comments are review text, not documents; the limit keeps one approved body bounded end to end. */
export const FORGE_COMMENT_MAX_BODY_BYTES = 64 * 1024
const HEAD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type ForgeCommentTarget = {
  instanceId: string
  projectId: string
  kind: 'merge_request' | 'issue'
  iid: number
}

/** The exact text the owner approves; the host appends its own marker only at publish time. */
export type ForgeCommentDraft = {
  kind: 'comment'
  target: ForgeCommentTarget
  /** The merge request head the draft was written against; null when the target has no head. */
  headSha: string | null
  body: string
}

export type ForgeCommentDraftFailure =
  | 'body-empty'
  | 'body-too-large'
  | 'target-invalid'
  | 'head-invalid'

export type ForgeCommentDraftResult =
  | { ok: true; draft: ForgeCommentDraft; hash: string }
  | { ok: false; reason: ForgeCommentDraftFailure }

const itemIdentity = z.string().min(1).max(512)

const targetSchema = z
  .object({
    instanceId: itemIdentity,
    projectId: itemIdentity,
    kind: z.enum(['merge_request', 'issue']),
    iid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const draftSchema = z
  .object({
    kind: z.literal('comment'),
    target: targetSchema,
    headSha: z.string().regex(HEAD_SHA).nullable(),
    body: z.string()
  })
  .strict()

export function buildForgeCommentDraft(input: {
  target: ForgeCommentTarget
  headSha: string | null
  body: string
}): ForgeCommentDraftResult {
  if (!targetSchema.safeParse(input.target).success) {
    return { ok: false, reason: 'target-invalid' }
  }
  if (input.headSha !== null && !HEAD_SHA.test(input.headSha)) {
    return { ok: false, reason: 'head-invalid' }
  }
  if (input.body.trim() === '') {
    return { ok: false, reason: 'body-empty' }
  }
  if (Buffer.byteLength(input.body, 'utf8') > FORGE_COMMENT_MAX_BODY_BYTES) {
    return { ok: false, reason: 'body-too-large' }
  }
  const draft: ForgeCommentDraft = {
    kind: 'comment',
    target: { ...input.target },
    headSha: input.headSha,
    body: input.body
  }
  return { ok: true, draft, hash: hashForgeCommentDraft(draft) }
}

/** Stable regardless of key order, so the displayed hash is the one approval checks. */
export function hashForgeCommentDraft(draft: ForgeCommentDraft): string {
  return createHash('sha256').update(canonicalJson(draft), 'utf8').digest('hex')
}

/** Null for anything that is not exactly a valid comment draft: an unknown body is never published. */
export function parseForgeCommentDraft(body: unknown): ForgeCommentDraft | null {
  const parsed = draftSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const built = buildForgeCommentDraft(parsed.data)
  return built.ok ? built.draft : null
}

/** Invisible in review text, unique per approval, and what reconciliation searches for. */
export function forgeCommentMarker(proposalId: number, hash: string): string {
  return `<!-- orca-forge-comment:${proposalId}:${hash.slice(0, 16)} -->`
}

export function forgeCommentBodyWithMarker(draft: ForgeCommentDraft, marker: string): string {
  return `${draft.body}\n\n${marker}`
}
