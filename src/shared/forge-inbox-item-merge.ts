/** What a person's confirmation of a merge recommendation can produce; fixed codes only. */
export type ForgeItemMergeFailure =
  | 'not-found'
  | 'not-a-merge-request'
  | 'not-open'
  | 'no-recommendation'
  | 'not-recommended'
  | 'no-expected-sha'
  | 'draft'
  | 'head-moved'
  | 'not-mergeable'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'bad-response'
  | 'stale-config'
  | 'no-credential'
  | 'cancelled'

export type ForgeItemMergeOutcome = { ok: true } | { ok: false; reason: ForgeItemMergeFailure }

export type ForgeInboxItemMergeOutcome = { ownerHostId: string } & ForgeItemMergeOutcome
