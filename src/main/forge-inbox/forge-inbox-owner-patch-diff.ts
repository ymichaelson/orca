import type { ForgeProposalDiffOutcome } from '../../shared/forge-inbox-rpc-types'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type { MainHttpClient } from '../network/http-client'
import { createGitlabPatchSource } from './forge-inbox-gitlab-patch-source'
import { createForgeOwnerGitlabReader } from './forge-inbox-gitlab-owner-reader'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { hashForgePatchDraft, parseForgePatchDraft } from './forge-inbox-patch-draft'
import { readForgePatchPreviewDiff } from './forge-inbox-patch-preview-diff'

export type ForgeOwnerPatchDiff = (
  input: { scope: ForgeInstanceScope; proposalId: number },
  signal: AbortSignal
) => Promise<ForgeProposalDiffOutcome | null>

/**
 * The exact diff the owner is asked to approve, built from the pinned base with the host's read
 * credential. A proposal in another instance is answered with null, never another draft.
 */
export function createForgeOwnerPatchDiff(deps: {
  ledger: ForgeInboxLedger
  http: Pick<MainHttpClient, 'fetch'>
  signal: AbortSignal
}): ForgeOwnerPatchDiff {
  return async (input, signal) => {
    const proposal = deps.ledger.getProposal(input.proposalId)
    if (!proposal || !deps.ledger.getItem(input.scope, proposal.itemId)) {
      return null
    }
    const draft = parseForgePatchDraft(proposal.body)
    if (!draft) {
      return { ok: false, reason: 'not-a-patch' }
    }
    const owner = createForgeOwnerGitlabReader(
      {
        ledger: deps.ledger,
        http: deps.http,
        signal: AbortSignal.any([deps.signal, signal])
      },
      draft.target
    )
    if (!owner.ok) {
      return { ok: false, reason: 'base-unavailable' }
    }
    const rendered = await readForgePatchPreviewDiff(
      draft,
      createGitlabPatchSource({ reader: owner.reader, ref: draft.baseSha })
    )
    return rendered.ok
      ? { ok: true, hash: hashForgePatchDraft(draft), text: rendered.text }
      : rendered
  }
}
