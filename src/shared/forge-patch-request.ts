/** A request replays by caller_key + operation_id, so both identifiers are bounded and control-free. */
export const FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS = 128

export const FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS = 64 * 1024
export const FORGE_PATCH_REQUEST_MAX_PATHS = 256
export const FORGE_PATCH_REQUEST_MAX_PATH_CHARS = 1024

/** Control characters never belong in an identifier or a path; they would hide in logs and keys. */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/** A process died mid-turn; the next read must replay this coded outcome, never guess. */
export const FORGE_PATCH_REQUEST_INTERRUPTED = 'interrupted'

export type ForgePatchRequestInterruptedReason = typeof FORGE_PATCH_REQUEST_INTERRUPTED

export const FORGE_PATCH_REQUEST_STATES = [
  'in_progress',
  'succeeded',
  'failed',
  'unverifiable'
] as const

export type ForgePatchRequestState = (typeof FORGE_PATCH_REQUEST_STATES)[number]

/** The claim rejected the request before any work started; nothing durable changed. */
export const FORGE_PATCH_REQUEST_REFUSAL_REASONS = [
  'invalid-caller',
  'invalid-operation-id',
  'invalid-intent',
  'intent-conflict',
  'run-not-found',
  'run-not-eligible',
  'session-not-bound',
  'revision-stale',
  'policy-stale',
  'project-unavailable'
] as const

export type ForgePatchRequestRefusal = (typeof FORGE_PATCH_REQUEST_REFUSAL_REASONS)[number]

export const FORGE_PATCH_REQUEST_FAILURE_REASONS = [
  'producer-failed',
  'draft-invalid',
  'draft-hash-invalid',
  'draft-hash-mismatch',
  'target-mismatch',
  'run-mismatch',
  'session-mismatch',
  'run-not-eligible',
  'item-not-merge-request',
  'revision-stale',
  'policy-stale',
  'config-stale',
  'project-unavailable',
  'invalidation-stale',
  'session-binding-lost'
] as const

export type ForgePatchRequestFailureReason = (typeof FORGE_PATCH_REQUEST_FAILURE_REASONS)[number]

export const FORGE_PATCH_REQUEST_UNVERIFIABLE_REASONS = ['unknown-outcome'] as const

export type ForgePatchRequestUnverifiableReason =
  (typeof FORGE_PATCH_REQUEST_UNVERIFIABLE_REASONS)[number]

/** Approval names the exact draft; every refusal here happens before a byte reaches a tree. */
export const FORGE_PATCH_APPROVAL_REFUSAL_REASONS = [
  'not-found',
  'not-pending',
  'stale',
  'not-a-patch',
  'draft-mismatch',
  'head-unavailable',
  'head-moved',
  'not-approved',
  'already-applied'
] as const

export type ForgePatchApprovalRefusal = (typeof FORGE_PATCH_APPROVAL_REFUSAL_REASONS)[number]

/** The approved tree could not be rebuilt; no project checkout and no remote is touched. */
export const FORGE_PATCH_APPLY_FAILURE_REASONS = [
  'base-missing',
  'base-unexpected',
  'base-mismatch',
  'base-unsupported',
  'source-unavailable',
  'path-unsafe',
  'write-failed',
  'aborted'
] as const

export type ForgePatchApplyFailureReason = (typeof FORGE_PATCH_APPLY_FAILURE_REASONS)[number]

/** Producing adds refusals that only the turn can prove; the claim's reasons stay unchanged. */
export const FORGE_PATCH_PRODUCE_REFUSAL_REASONS = [
  ...FORGE_PATCH_REQUEST_REFUSAL_REASONS,
  'session-missing',
  'session-not-protected',
  'send-refused',
  'finish-refused'
] as const

export type ForgePatchProduceRefusal = (typeof FORGE_PATCH_PRODUCE_REFUSAL_REASONS)[number]
