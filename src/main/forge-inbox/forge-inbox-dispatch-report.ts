import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits'

export const DISPATCH_REPORT_FENCE_TAG = 'orca-effect-report'
export const DISPATCH_REPORT_MAX_CLAIMS = 8
export const DISPATCH_RECOMMENDATION_MAX_REASON_BYTES = 512

const MAX_BLOCK_BYTES = 4096
const HEX_SHA = /^[0-9a-f]{40}$/
const MODES = ['read-only', 'remote-actions', 'unknown'] as const
const CLAIM_KINDS = ['comment', 'approve', 'merge', 'unfinished'] as const
const TARGET_KINDS = ['merge_request', 'issue'] as const
const RECOMMENDATION_ACTIONS = ['merge', 'request-changes', 'close', 'none'] as const

export type DispatchClaimKind = (typeof CLAIM_KINDS)[number]
export type DispatchRecommendationAction = (typeof RECOMMENDATION_ACTIONS)[number]

export type DispatchRecommendation = {
  action: DispatchRecommendationAction
  reason: string | null
}

export type DispatchClaim = {
  kind: DispatchClaimKind
  target: { kind: (typeof TARGET_KINDS)[number]; iid: number }
  noteId?: number
  expectedHeadSha?: string
}

/** `ambiguous` is a report that was attempted but cannot be read as exactly one valid contract. */
export type DispatchReportCapture =
  | {
      status: 'claims'
      mode: (typeof MODES)[number]
      claims: DispatchClaim[]
      /** Absent from reports written before recommendations existed. */
      recommendation?: DispatchRecommendation | null
    }
  | { status: 'report-missing' }
  | { status: 'ambiguous' }

const MISSING: DispatchReportCapture = { status: 'report-missing' }
const AMBIGUOUS: DispatchReportCapture = { status: 'ambiguous' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | undefined {
  return options.find((option) => option === value)
}

function parseClaim(value: unknown): DispatchClaim | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'target', 'noteId', 'expectedHeadSha'])) {
    return null
  }
  const kind = oneOf(CLAIM_KINDS, value.kind)
  const target = value.target
  if (!kind || !isRecord(target) || !hasOnlyKeys(target, ['kind', 'iid'])) {
    return null
  }
  const targetKind = oneOf(TARGET_KINDS, target.kind)
  if (!targetKind || !positiveInt(target.iid)) {
    return null
  }
  const claim: DispatchClaim = { kind, target: { kind: targetKind, iid: target.iid } }
  if (value.noteId !== undefined) {
    if (kind !== 'comment' || !positiveInt(value.noteId)) {
      return null
    }
    claim.noteId = value.noteId
  }
  if (value.expectedHeadSha !== undefined) {
    if (
      (kind !== 'approve' && kind !== 'merge') ||
      typeof value.expectedHeadSha !== 'string' ||
      !HEX_SHA.test(value.expectedHeadSha)
    ) {
      return null
    }
    claim.expectedHeadSha = value.expectedHeadSha
  }
  return claim
}

/** Absent is not invalid: a report written before recommendations existed still parses. */
function parseRecommendation(
  value: unknown
): { ok: true; recommendation: DispatchRecommendation | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, recommendation: null }
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['action', 'reason'])) {
    return { ok: false }
  }
  const action = oneOf(RECOMMENDATION_ACTIONS, value.action)
  if (!action || (value.reason !== undefined && typeof value.reason !== 'string')) {
    return { ok: false }
  }
  const reason =
    typeof value.reason === 'string'
      ? clampUtf8TextPrefix(value.reason.trim(), DISPATCH_RECOMMENDATION_MAX_REASON_BYTES).trim()
      : ''
  return { ok: true, recommendation: { action, reason: reason === '' ? null : reason } }
}

function parseBody(body: string): DispatchReportCapture {
  if (Buffer.byteLength(body, 'utf8') > MAX_BLOCK_BYTES) {
    return AMBIGUOUS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return AMBIGUOUS
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['v', 'mode', 'claims', 'recommendation'])) {
    return AMBIGUOUS
  }
  const mode = oneOf(MODES, parsed.mode)
  if (parsed.v !== 1 || !mode || !Array.isArray(parsed.claims)) {
    return AMBIGUOUS
  }
  if (parsed.claims.length > DISPATCH_REPORT_MAX_CLAIMS) {
    return AMBIGUOUS
  }
  const claims: DispatchClaim[] = []
  for (const entry of parsed.claims) {
    const claim = parseClaim(entry)
    if (!claim) {
      return AMBIGUOUS
    }
    claims.push(claim)
  }
  // A read-only report that also claims a mutation contradicts itself, so neither half is trusted.
  if (mode === 'read-only' && claims.some((claim) => claim.kind !== 'unfinished')) {
    return AMBIGUOUS
  }
  const recommendation = parseRecommendation(parsed.recommendation)
  if (!recommendation.ok) {
    return AMBIGUOUS
  }
  return {
    status: 'claims',
    mode,
    claims,
    ...(recommendation.recommendation === null
      ? {}
      : { recommendation: recommendation.recommendation })
  }
}

/**
 * Reads the agent's final message as untrusted text: only an exact fenced block that ends the
 * message (so a second block always trails the first) and validates strictly yields claims. Absence is never read as "nothing was done".
 */
export function parseDispatchReport(text: string | null): DispatchReportCapture {
  if (text === null) {
    return MISSING
  }
  const lines = text.split(/\r?\n/)
  const opener = lines.findIndex((line) =>
    line.trim().startsWith(`\`\`\`${DISPATCH_REPORT_FENCE_TAG}`)
  )
  if (opener === -1) {
    return MISSING
  }
  if (lines[opener].trimEnd() !== `\`\`\`${DISPATCH_REPORT_FENCE_TAG}`) {
    return AMBIGUOUS
  }
  const closer = lines.findIndex((line, index) => index > opener && line.trimEnd() === '```')
  if (closer === -1 || lines.slice(closer + 1).some((line) => line.trim() !== '')) {
    return AMBIGUOUS
  }
  return parseBody(lines.slice(opener + 1, closer).join('\n'))
}

/** The stored capture is host-written, but a damaged row reads as ambiguous rather than being trusted. */
export function readStoredDispatchReport(json: string | null): DispatchReportCapture {
  if (json === null) {
    return MISSING
  }
  let stored: unknown
  try {
    stored = JSON.parse(json)
  } catch {
    return AMBIGUOUS
  }
  if (!isRecord(stored)) {
    return AMBIGUOUS
  }
  if (stored.status === 'report-missing') {
    return MISSING
  }
  if (stored.status !== 'claims') {
    return AMBIGUOUS
  }
  return parseBody(
    JSON.stringify({
      v: 1,
      mode: stored.mode,
      claims: stored.claims,
      ...(stored.recommendation === undefined ? {} : { recommendation: stored.recommendation })
    })
  )
}
