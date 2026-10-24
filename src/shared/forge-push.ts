/** A commit message is shown whole in the approval dialog and stored in the plan, so it is bounded. */
export const FORGE_PUSH_MAX_MESSAGE_CHARS = 8 * 1024

/** Creating a push plan reads GitLab first; every refusal happens before a proposal exists. */
export const FORGE_PUSH_PROPOSAL_REFUSAL_REASONS = [
  'patch-invalid',
  'target-invalid',
  'branch-invalid',
  'base-invalid',
  'base-moved',
  'tree-invalid',
  'commit-invalid',
  'commit-mismatch',
  'run-missing',
  'item-missing',
  'item-mismatch',
  'patch-missing',
  'patch-mismatch',
  'patch-not-applied',
  'project-unavailable',
  'identity-unavailable',
  'base-unavailable',
  'base-unsupported',
  'base-unverified',
  'host-unavailable'
] as const

export type ForgePushProposalRefusal = (typeof FORGE_PUSH_PROPOSAL_REFUSAL_REASONS)[number]

/** Approval names the exact plan and the branch head it was built on; nothing is pushed here. */
export const FORGE_PUSH_APPROVAL_REFUSAL_REASONS = [
  'not-found',
  'not-pending',
  'stale',
  'not-a-push',
  'draft-mismatch',
  'head-unavailable',
  'head-moved'
] as const

export type ForgePushApprovalRefusal = (typeof FORGE_PUSH_APPROVAL_REFUSAL_REASONS)[number]

/** Refusals happen before the receipt; a missing credential refuses instead of pushing unauthenticated. */
export const FORGE_PUSH_APPLY_REFUSAL_REASONS = [
  'not-found',
  'not-a-push',
  'plan-mismatch',
  'not-approved',
  'already-pushed',
  'project-unavailable',
  'no-credential',
  'workspace-failed'
] as const

export type ForgePushApplyRefusal = (typeof FORGE_PUSH_APPLY_REFUSAL_REASONS)[number]

/** A run that started is always traceable by its receipt, even when the remote answer is unknown. */
export const FORGE_PUSH_FAILURE_REASONS = [
  'base-unavailable',
  'base-unsupported',
  'base-unverified',
  'tree-invalid',
  'tree-mismatch',
  'git-unavailable',
  'rejected',
  'internal'
] as const

export type ForgePushFailureReason = (typeof FORGE_PUSH_FAILURE_REASONS)[number]
