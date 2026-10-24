import type { ForgeInstanceScope, ForgeProposal } from '../../shared/forge-inbox-types'
import type { ForgePatchApprovalRefusal } from '../../shared/forge-patch-request'
import {
  buildForgePatchDraft,
  hashForgePatchDraft,
  parseForgePatchDraft,
  type ForgePatchDraft,
  type ForgePatchDraftFailure
} from './forge-inbox-patch-draft'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { approveForgeProposal } from './forge-inbox-proposal-approval'

export type ForgePatchHead = { ok: true; sha: string } | { ok: false; code: string }
export type ForgePatchHeadReader = (
  request: { instanceId: string; projectId: string; branch: string },
  signal: AbortSignal
) => Promise<ForgePatchHead>

export type ForgePatchProposalFailure =
  | ForgePatchDraftFailure
  | 'run-missing'
  | 'item-missing'
  | 'item-mismatch'
  | 'run-not-running'
  | 'generation-mismatch'
  | 'policy-generation-mismatch'
  | 'not-found'
  | 'not-pending'
  | 'not-a-patch'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'
  | 'stale'

export type ForgePatchProposalCreated =
  | { ok: true; proposal: ForgeProposal; draft: ForgePatchDraft; hash: string }
  | { ok: false; reason: ForgePatchProposalFailure }

/** Creation-time refusals cannot come back from approval; the narrower type keeps that honest. */
export type ForgePatchApprovalFailure = Exclude<
  ForgePatchApprovalRefusal,
  'not-approved' | 'already-applied'
>

export type ForgePatchProposalApproved =
  | { ok: true; proposal: ForgeProposal }
  | { ok: false; reason: ForgePatchApprovalFailure }

/**
 * Creates the one patch the owner may approve for this run's item. The manifest must target the
 * item's project; a newer patch makes older pending ones stale instead of leaving two live changes.
 */
export function createForgePatchProposal(
  deps: { ledger: Pick<ForgeInboxLedger, 'getRun' | 'getItem' | 'createProposal'> },
  input: {
    scope: ForgeInstanceScope
    runId: number
    expectedGeneration: number
    draft: {
      target: { instanceId: string; projectId: string }
      baseSha: string
      branch: string
      operations: ForgePatchDraft['operations']
    }
  }
): ForgePatchProposalCreated {
  const built = buildForgePatchDraft(input.draft)
  if (!built.ok) {
    return built
  }
  const run = deps.ledger.getRun(input.runId)
  if (!run) {
    return { ok: false, reason: 'run-missing' }
  }
  const item = deps.ledger.getItem(input.scope, run.itemId)
  if (!item) {
    return { ok: false, reason: 'item-missing' }
  }
  const draft = built.draft
  if (draft.target.instanceId !== item.instanceId || draft.target.projectId !== item.projectId) {
    return { ok: false, reason: 'item-mismatch' }
  }
  const created = deps.ledger.createProposal({
    runId: input.runId,
    expectedGeneration: input.expectedGeneration,
    body: draft,
    supersedePending: true
  })
  if (!created.ok) {
    return created
  }
  return { ok: true, proposal: created.proposal, draft, hash: built.hash }
}

/**
 * Consumes a patch approval exactly once. A branch head that moved since the manifest was built
 * makes it stale; an unreadable head leaves it pending.
 */
export async function approveForgePatch(
  deps: {
    ledger: Pick<ForgeInboxLedger, 'getProposal' | 'getItem' | 'consumeProposal' | 'staleProposal'>
    readHead: ForgePatchHeadReader
  },
  input: {
    scope: ForgeInstanceScope
    proposalId: number
    expectedHash: string
    expectedRevision: number
    expectedPolicyGeneration: number
  },
  signal: AbortSignal
): Promise<ForgePatchProposalApproved> {
  const result = await approveForgeProposal(
    {
      ledger: deps.ledger,
      parseDraft: parseForgePatchDraft,
      hashDraft: hashForgePatchDraft,
      checkHead: async (draft) => {
        const head = await deps.readHead(
          {
            instanceId: draft.target.instanceId,
            projectId: draft.target.projectId,
            branch: draft.branch
          },
          signal
        )
        if (!head.ok) {
          return 'head-unavailable'
        }
        return head.sha === draft.baseSha ? 'ok' : 'head-moved'
      }
    },
    input
  )
  if (result.ok) {
    return result
  }
  return result.reason === 'not-this-kind'
    ? { ok: false, reason: 'not-a-patch' }
    : { ok: false, reason: result.reason }
}
