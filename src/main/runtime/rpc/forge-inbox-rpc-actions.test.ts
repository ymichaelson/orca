import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { buildForgeCommentDraft } from '../../forge-inbox/forge-inbox-comment-draft'
import { INSTANCE_ID, PROJECT_ID } from '../../forge-inbox/forge-inbox-webhook-test-harness'
import {
  configure,
  createForgeRpcHarness,
  errorCodeOf,
  recordOf,
  seedItem,
  type ForgeRpcHarness
} from './forge-inbox-rpc-test-kit'

const HEAD = 'a'.repeat(40)
const BODY = 'Nit: rename this local before merging.'

type Seeded = {
  ownerHostId: string
  proposalId: number
  hash: string
  ledger: ReturnType<ForgeRpcHarness['openLedger']>
}

describe('forge inbox rpc proposal actions', () => {
  let harness: ForgeRpcHarness
  afterEach(() => harness.close())

  async function seedPendingComment(): Promise<Seeded> {
    harness = await createForgeRpcHarness()
    const ownerHostId = await configure(harness)
    const ledger = harness.openLedger(ownerHostId)
    const seeded = seedItem(ledger, ownerHostId, 1)
    const claimed = ledger.claimNextQueuedRun({ instanceId: INSTANCE_ID })
    if (!claimed) {
      throw new Error('no run was queued')
    }
    const built = buildForgeCommentDraft({
      target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID, kind: 'merge_request', iid: 7 },
      headSha: HEAD,
      body: BODY
    })
    if (!built.ok) {
      throw new Error(`draft rejected: ${built.reason}`)
    }
    const made = ledger.createProposal({
      runId: claimed.id,
      expectedGeneration: claimed.generation,
      body: built.draft
    })
    if (!made.ok) {
      throw new Error(`proposal rejected: ${made.reason}`)
    }
    expect(seeded.itemId).toBeGreaterThan(0)
    return { ownerHostId, proposalId: made.proposal.id, hash: built.hash, ledger }
  }

  it('shows the exact draft the proposal will send, under its bound hash', async () => {
    const { ownerHostId, proposalId, hash } = await seedPendingComment()

    const view = await harness.ok('forgeInbox.getProposal', { ownerHostId, proposalId })

    expect(view.proposal).toMatchObject({
      proposalId,
      kind: 'comment',
      status: 'pending',
      hash,
      headSha: HEAD,
      body: BODY,
      target: { instanceId: INSTANCE_ID, projectId: PROJECT_ID, kind: 'merge_request', iid: 7 }
    })
  })

  it('answers a proposal outside the addressed instance with nothing, not another project’s draft', async () => {
    const { ownerHostId, proposalId } = await seedPendingComment()

    const view = await harness.ok('forgeInbox.getProposal', {
      ownerHostId,
      instanceId: 'gitlab-elsewhere',
      proposalId
    })

    expect(view.proposal).toBeNull()
  })

  it('refuses an approval whose displayed hash differs before reading any credential', async () => {
    const { ownerHostId, proposalId, ledger } = await seedPendingComment()
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }

    const response = await harness.call(
      'forgeInbox.approveComment',
      {
        ownerHostId,
        proposalId,
        expectedHash: 'b'.repeat(64),
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      'paired-a'
    )

    expect(response.ok && response.result).toMatchObject({ ok: false, reason: 'draft-mismatch' })
    expect(ledger.getProposal(proposalId)?.status).toBe('pending')
  })

  it('does not consume an approved draft when the reviewed head cannot be read', async () => {
    const { ownerHostId, proposalId, hash, ledger } = await seedPendingComment()
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }

    const response = await harness.call(
      'forgeInbox.approveComment',
      {
        ownerHostId,
        proposalId,
        expectedHash: hash,
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      'paired-a'
    )

    expect(response.ok && response.result).toMatchObject({ ok: false, reason: 'head-unavailable' })
    expect(ledger.getProposal(proposalId)?.status).toBe('pending')
  })

  it('keeps approval and discussion off the phone allowlist', async () => {
    const { ownerHostId, proposalId, hash, ledger } = await seedPendingComment()
    const proposal = ledger.getProposal(proposalId)
    if (!proposal) {
      throw new Error('proposal vanished')
    }

    const approve = await harness.call(
      'forgeInbox.approveComment',
      {
        ownerHostId,
        proposalId,
        expectedHash: hash,
        expectedRevision: proposal.revision,
        expectedPolicyGeneration: proposal.policyGeneration
      },
      'mobile'
    )
    const discuss = await harness.call(
      'forgeInbox.discuss',
      { ownerHostId, runId: proposal.runId, message: 'why this change?' },
      'mobile'
    )

    expect(errorCodeOf(approve)).toBe('forbidden')
    expect(errorCodeOf(discuss)).toBe('forbidden')
  })

  it('rejects locally, then reports the same proposal as no longer pending', async () => {
    const { ownerHostId, proposalId, ledger } = await seedPendingComment()

    const first = await harness.call('forgeInbox.rejectProposal', { ownerHostId, proposalId })
    const second = await harness.call('forgeInbox.rejectProposal', { ownerHostId, proposalId })

    expect(first.ok && first.result).toEqual({ ownerHostId, ok: true })
    expect(second.ok && second.result).toEqual({ ownerHostId, ok: false, reason: 'not-pending' })
    expect(ledger.getProposal(proposalId)?.status).toBe('rejected')
    const view = await harness.ok('forgeInbox.getProposal', { ownerHostId, proposalId })
    expect(recordOf(view.proposal).status).toBe('rejected')
  })

  it('rejects nothing for another instance and names the mismatch for another owner', async () => {
    const { ownerHostId, proposalId } = await seedPendingComment()

    const foreign = await harness.ok('forgeInbox.rejectProposal', {
      ownerHostId,
      instanceId: 'gitlab-elsewhere',
      proposalId
    })
    const otherOwner = await harness.call('forgeInbox.rejectProposal', {
      ownerHostId: 'someone-else',
      proposalId
    })

    expect(foreign).toEqual({ ownerHostId, ok: false, reason: 'not-found' })
    expect(errorCodeOf(otherOwner)).toBe('forge_inbox_owner_mismatch')
  })

  it('refuses to discuss when this host wired no session reader', async () => {
    const { ownerHostId, proposalId, ledger } = await seedPendingComment()
    const runId = ledger.getProposal(proposalId)?.runId

    const response = await harness.call('forgeInbox.discuss', {
      ownerHostId,
      runId,
      message: 'why this change?'
    })

    expect(response.ok && response.result).toEqual({
      ownerHostId,
      kind: 'refused',
      reason: 'host-unavailable'
    })
  })
})
