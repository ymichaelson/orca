/**
 * What the host could confirm about a dispatched agent's remote changes. Every value here is
 * host-authored and fixed, so a client never receives report text or anything GitLab wrote.
 */
export const FORGE_DISPATCH_CONFIRMATION_STATES = [
  'unconfirmed',
  'confirmed',
  'contradicted',
  'unconfirmable',
  'no-claim'
] as const
export type ForgeDispatchConfirmationState = (typeof FORGE_DISPATCH_CONFIRMATION_STATES)[number]

export const FORGE_DISPATCH_CLAIM_KINDS = ['comment', 'approve', 'merge', 'unfinished'] as const
export type ForgeDispatchClaimKind = (typeof FORGE_DISPATCH_CLAIM_KINDS)[number]

export const FORGE_DISPATCH_CLAIM_TARGETS = ['merge_request', 'issue'] as const
export type ForgeDispatchClaimTarget = (typeof FORGE_DISPATCH_CLAIM_TARGETS)[number]

export const FORGE_DISPATCH_CLAIM_OUTCOMES = [
  'confirmed',
  'contradicted',
  'unproven',
  'unconfirmable'
] as const
export type ForgeDispatchClaimOutcome = (typeof FORGE_DISPATCH_CLAIM_OUTCOMES)[number]

/**
 * `state-only` means GitLab shows the state but cannot say this agent caused it: a person using
 * the same GitLab account is indistinguishable from the agent for approvals and merges.
 */
export const FORGE_DISPATCH_CLAIM_ATTRIBUTIONS = ['marker-author', 'state-only'] as const
export type ForgeDispatchClaimAttribution = (typeof FORGE_DISPATCH_CLAIM_ATTRIBUTIONS)[number]

export const FORGE_DISPATCH_CONFIRMATION_CODES = [
  'read-only-report',
  'report-missing',
  'report-ambiguous',
  'mode-unknown',
  'no-claims-reported',
  'binding-changed',
  'deadline',
  'unproven',
  'agent-unfinished',
  'off-target',
  'no-expected-sha',
  'sha-mismatch',
  'head-moved',
  'unreported-comment',
  'read-only-unchecked',
  'not-approved',
  'not-merged',
  'merged-by-other'
] as const
export type ForgeDispatchConfirmationCode = (typeof FORGE_DISPATCH_CONFIRMATION_CODES)[number]

export type ForgeDispatchConfirmationClaimView = {
  kind: ForgeDispatchClaimKind
  target: ForgeDispatchClaimTarget
  iid: number
  outcome: ForgeDispatchClaimOutcome
  attribution: ForgeDispatchClaimAttribution | null
}

export type ForgeDispatchConfirmationView = {
  state: ForgeDispatchConfirmationState
  claims: ForgeDispatchConfirmationClaimView[]
  checkedAt: number | null
  /** The fixed reason behind a final verdict; absent while a check is still open. */
  code?: ForgeDispatchConfirmationCode
}
