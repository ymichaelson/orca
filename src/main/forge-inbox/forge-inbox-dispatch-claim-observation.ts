import type { DispatchConfirmationReader } from './forge-inbox-dispatch-confirmation-reader'
import {
  judgeApproval,
  judgeComments,
  judgeMerge,
  readFailed,
  type ClaimOutcome,
  type ConfirmationItem
} from './forge-inbox-dispatch-confirmation-verdict'
import type { DispatchClaim } from './forge-inbox-dispatch-report'

export type Reads = { claim: DispatchClaim; index: number }

/** Reads GitLab once per target; any failed read leaves its claims unproven rather than guessed. */
export async function readOutcomes(
  reader: DispatchConfirmationReader,
  item: ConfirmationItem,
  marker: string,
  pending: readonly Reads[]
): Promise<Map<number, ClaimOutcome>> {
  const results = new Map<number, ClaimOutcome>()
  const user = await reader.getCurrentUser()
  if (!user.ok) {
    pending.forEach(({ claim, index }) => results.set(index, readFailed(claim)))
    return results
  }
  const username = user.data.username
  const commentGroups = new Map<string, Reads[]>()
  for (const entry of pending) {
    const { claim } = entry
    if (claim.kind === 'comment') {
      const key = `${claim.target.kind}:${claim.target.iid}`
      commentGroups.set(key, [...(commentGroups.get(key) ?? []), entry])
    }
  }
  for (const group of commentGroups.values()) {
    const { target } = group[0].claim
    const notes =
      target.kind === 'merge_request'
        ? await reader.listMergeRequestNotes(target.iid)
        : await reader.listIssueNotes(target.iid)
    if (!notes.ok) {
      group.forEach(({ claim, index }) => results.set(index, readFailed(claim)))
      continue
    }
    const judged = judgeComments(
      group.map((entry) => entry.claim),
      { data: notes.data, complete: notes.complete },
      marker,
      username
    )
    group.forEach(({ index }, position) => results.set(index, judged[position]))
  }
  for (const { claim, index } of pending) {
    if (claim.kind !== 'approve' && claim.kind !== 'merge') {
      continue
    }
    const mergeRequest = await reader.getMergeRequestState(claim.target.iid)
    if (!mergeRequest.ok) {
      results.set(index, readFailed(claim))
      continue
    }
    if (claim.kind === 'merge') {
      results.set(index, judgeMerge(item, claim, mergeRequest.data, username))
      continue
    }
    const approvals = await reader.getMergeRequestApprovals(claim.target.iid)
    results.set(
      index,
      approvals.ok
        ? judgeApproval(item, claim, mergeRequest.data, approvals.data, username)
        : readFailed(claim)
    )
  }
  return results
}
