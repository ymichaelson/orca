import type { DispatchClaim } from './forge-inbox-dispatch-report'
import type {
  ConfirmationApprovals,
  ConfirmationMergeRequest
} from './forge-inbox-dispatch-confirmation-reader'
import type { GitlabNote } from './forge-inbox-gitlab-api-schemas'

export type ClaimOutcome = {
  kind: DispatchClaim['kind']
  outcome: 'confirmed' | 'contradicted' | 'unproven' | 'unconfirmable'
  code: string
  attribution: 'marker-author' | 'state-only' | null
}

export type ConfirmationItem = {
  itemKind: string
  itemIid: number
  gitlabProjectId: number
  expectedSha: string | null
}

const outcome = (
  claim: DispatchClaim,
  verdict: ClaimOutcome['outcome'],
  code: string,
  attribution: ClaimOutcome['attribution'] = null
): ClaimOutcome => ({ kind: claim.kind, outcome: verdict, code, attribution })

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * A claim about anything but the item itself is only readable for a project item, whose events
 * name no GitLab object of their own; the project-scoped reader keeps those inside the binding.
 */
function isOwnTarget(item: ConfirmationItem, claim: DispatchClaim): boolean {
  return (
    item.itemKind === 'project' ||
    (claim.target.kind === item.itemKind && claim.target.iid === item.itemIid)
  )
}

/**
 * The revision an approval or merge is held to. A project item was prompted with a push head,
 * which says nothing about a merge request's head, so only the agent's own report can name one.
 */
function referenceSha(item: ConfirmationItem, claim: DispatchClaim): string | null {
  return item.itemKind === 'project'
    ? (claim.expectedHeadSha ?? null)
    : (item.expectedSha ?? claim.expectedHeadSha ?? null)
}

export function preReadOutcome(item: ConfirmationItem, claim: DispatchClaim): ClaimOutcome | null {
  if (claim.kind === 'unfinished') {
    return outcome(claim, 'unconfirmable', 'agent-unfinished')
  }
  if (!isOwnTarget(item, claim)) {
    return outcome(claim, 'unconfirmable', 'off-target')
  }
  if (claim.kind === 'approve' || claim.kind === 'merge') {
    if (referenceSha(item, claim) === null) {
      return outcome(claim, 'unconfirmable', 'no-expected-sha')
    }
    if (
      item.itemKind !== 'project' &&
      item.expectedSha !== null &&
      claim.expectedHeadSha !== undefined &&
      claim.expectedHeadSha !== item.expectedSha
    ) {
      return outcome(claim, 'contradicted', 'sha-mismatch')
    }
  }
  return null
}

export type StrayCommentScan = 'found' | 'clean' | 'incomplete'

/** A marker note nobody reported contradicts a read-only report; a partial list cannot clear it. */
export function scanForStrayComments(
  notes: { data: readonly GitlabNote[]; complete: boolean },
  marker: string,
  username: string
): StrayCommentScan {
  const stray = notes.data.some(
    (note) => !note.system && sameUser(note.author, username) && note.body.includes(marker)
  )
  if (stray) {
    return 'found'
  }
  return notes.complete ? 'clean' : 'incomplete'
}

/** Marker notes by the current user prove presence; their absence proves nothing. */
export function judgeComments(
  claims: readonly DispatchClaim[],
  notes: { data: readonly GitlabNote[]; complete: boolean },
  marker: string,
  username: string
): ClaimOutcome[] {
  const proofs = notes.data.filter(
    (note) => !note.system && sameUser(note.author, username) && note.body.includes(marker)
  )
  const proofIds = new Set(proofs.map((note) => note.id))
  return claims.map((claim, index) => {
    if (proofs.length <= index) {
      return outcome(
        claim,
        'unproven',
        notes.complete ? 'marker-not-found' : 'marker-not-found-truncated'
      )
    }
    if (claim.noteId !== undefined && !proofIds.has(claim.noteId)) {
      return outcome(claim, 'unproven', 'note-id-mismatch')
    }
    return outcome(claim, 'confirmed', 'marker-note', 'marker-author')
  })
}

export function judgeApproval(
  item: ConfirmationItem,
  claim: DispatchClaim,
  mergeRequest: ConfirmationMergeRequest,
  approvals: ConfirmationApprovals,
  username: string
): ClaimOutcome {
  if (
    mergeRequest.targetProjectId !== null &&
    mergeRequest.targetProjectId !== item.gitlabProjectId
  ) {
    return outcome(claim, 'unconfirmable', 'off-target')
  }
  if (mergeRequest.sha !== referenceSha(item, claim)) {
    return outcome(claim, 'unconfirmable', 'head-moved')
  }
  const approved =
    approvals.userHasApproved === true ||
    approvals.approvedBy.some((user) => sameUser(user, username))
  return approved
    ? outcome(claim, 'confirmed', 'approved-at-sha', 'state-only')
    : outcome(claim, 'contradicted', 'not-approved')
}

export function judgeMerge(
  item: ConfirmationItem,
  claim: DispatchClaim,
  mergeRequest: ConfirmationMergeRequest,
  username: string
): ClaimOutcome {
  if (
    mergeRequest.targetProjectId !== null &&
    mergeRequest.targetProjectId !== item.gitlabProjectId
  ) {
    return outcome(claim, 'unconfirmable', 'off-target')
  }
  if (mergeRequest.state === 'closed') {
    return outcome(claim, 'contradicted', 'not-merged')
  }
  if (mergeRequest.state !== 'merged') {
    return outcome(claim, 'unproven', 'not-merged-yet')
  }
  if (mergeRequest.mergedBy !== null && !sameUser(mergeRequest.mergedBy, username)) {
    return outcome(claim, 'contradicted', 'merged-by-other')
  }
  if (mergeRequest.sha !== referenceSha(item, claim)) {
    return outcome(claim, 'unconfirmable', 'head-moved')
  }
  return outcome(claim, 'confirmed', 'merged-at-sha', 'state-only')
}

export const readFailed = (claim: DispatchClaim): ClaimOutcome =>
  outcome(claim, 'unproven', 'read-failed')

export type ConfirmationRollUp =
  | {
      kind: 'final'
      state: 'confirmed' | 'contradicted' | 'unconfirmable' | 'no-claim'
      code: string | null
    }
  | { kind: 'pending' }

/** One contradiction decides; anything unproven waits; otherwise the weakest proven claim decides. */
export function rollUpClaims(outcomes: readonly ClaimOutcome[]): ConfirmationRollUp {
  const contradicted = outcomes.find((claim) => claim.outcome === 'contradicted')
  if (contradicted) {
    return { kind: 'final', state: 'contradicted', code: contradicted.code }
  }
  if (outcomes.some((claim) => claim.outcome === 'unproven')) {
    return { kind: 'pending' }
  }
  const unconfirmable = outcomes.find((claim) => claim.outcome === 'unconfirmable')
  return unconfirmable
    ? { kind: 'final', state: 'unconfirmable', code: unconfirmable.code }
    : { kind: 'final', state: 'confirmed', code: null }
}
