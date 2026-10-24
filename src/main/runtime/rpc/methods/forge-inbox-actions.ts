import type {
  ForgeInboxApprovePatchOutcome,
  ForgeInboxCommentApprovalOutcome,
  ForgeInboxDiscussOutcome,
  ForgeInboxProposalDiffView,
  ForgeInboxProposalPreviewView,
  ForgeInboxProposalRejectOutcome,
  ForgeInboxProposePatchOutcome,
  ForgeInboxPushApplyOutcome,
  ForgeInboxPushProposalOutcome
} from '../../../../shared/forge-inbox-rpc-types'
import {
  ForgeInboxApproveCommentParams,
  ForgeInboxApprovePatchParams,
  ForgeInboxApprovePushParams,
  ForgeInboxDiscussParams,
  ForgeInboxProposalParams,
  ForgeInboxProposePatchParams,
  ForgeInboxProposePushParams,
  ForgeInboxRejectProposalParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod, type RpcContext } from '../core'
import { forgeOwnerFor, forgeReaderId, guardForgeInbox } from '../forge-inbox-owner-gate'

const { unavailable } = FORGE_INBOX_RPC_ERROR_CODES

function scopeOf(instanceId: string | undefined) {
  return instanceId === undefined ? {} : { instanceId }
}

/** A handler with no socket signal still needs one to hand the broker, and a fresh one never aborts. */
function signalOf(context: RpcContext): AbortSignal {
  return context.signal ?? new AbortController().signal
}

/** The exact draft a human approves; only read here, never carried in list or detail projections. */
export const FORGE_INBOX_PROPOSAL_READ_METHODS = [
  defineMethod({
    name: 'forgeInbox.getProposal',
    permission: 'workspace',
    params: ForgeInboxProposalParams,
    handler: (params, context): Promise<ForgeInboxProposalPreviewView> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, () => ({
        ownerHostId: params.ownerHostId,
        proposal: service.getProposalPreview(scopeOf(params.instanceId), params.proposalId)
      }))
    }
  }),
  // Why the owner's read credential: the diff must be the exact one approval applies, not a guess.
  defineMethod({
    name: 'forgeInbox.getProposalDiff',
    permission: 'workspace',
    params: ForgeInboxProposalParams,
    handler: (params, context): Promise<ForgeInboxProposalDiffView> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        diff: await service.getProposalDiff(
          { scope: scopeOf(params.instanceId), proposalId: params.proposalId },
          signalOf(context),
          params.ownerHostId
        )
      }))
    }
  })
]

/**
 * Approval reaches GitLab with the host's write credential, so it needs host-admin: a paired desktop
 * has it, and a phone that only got the read allowlist does not.
 */
export const FORGE_INBOX_PROPOSAL_ACTION_METHODS = [
  defineMethod({
    name: 'forgeInbox.approveComment',
    permission: 'host-admin',
    params: ForgeInboxApproveCommentParams,
    handler: (params, context): Promise<ForgeInboxCommentApprovalOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.approveComment(
          {
            scope: scopeOf(params.instanceId),
            proposalId: params.proposalId,
            expectedHash: params.expectedHash,
            expectedRevision: params.expectedRevision,
            expectedPolicyGeneration: params.expectedPolicyGeneration
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  }),
  // Why host-admin: the owner consumes the approval and builds the tree with its own credential.
  defineMethod({
    name: 'forgeInbox.approvePatch',
    permission: 'host-admin',
    params: ForgeInboxApprovePatchParams,
    handler: (params, context): Promise<ForgeInboxApprovePatchOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.approvePatch(
          {
            scope: scopeOf(params.instanceId),
            proposalId: params.proposalId,
            expectedHash: params.expectedHash,
            expectedRevision: params.expectedRevision,
            expectedPolicyGeneration: params.expectedPolicyGeneration
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  }),
  // Why workspace: a rejection writes local state only, never the project switch or the network.
  defineMethod({
    name: 'forgeInbox.rejectProposal',
    permission: 'workspace',
    params: ForgeInboxRejectProposalParams,
    handler: (params, context): Promise<ForgeInboxProposalRejectOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, () => ({
        ownerHostId: params.ownerHostId,
        ...service.rejectProposal(scopeOf(params.instanceId), params.proposalId)
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.discuss',
    permission: 'workspace',
    params: ForgeInboxDiscussParams,
    handler: (params, context): Promise<ForgeInboxDiscussOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.discuss(
          {
            scope: scopeOf(params.instanceId),
            runId: params.runId,
            message: params.message
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  }),
  // Why workspace: the turn produces a local proposal only; publishing it stays a separate approval.
  defineMethod({
    name: 'forgeInbox.proposePatch',
    permission: 'workspace',
    params: ForgeInboxProposePatchParams,
    handler: (params, context): Promise<ForgeInboxProposePatchOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const callerKey = forgeReaderId(context)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.proposePatch(
          {
            scope: scopeOf(params.instanceId),
            callerKey,
            operationId: params.operationId,
            runId: params.runId,
            message: params.message,
            paths: params.paths ?? []
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  }),
  // Why workspace: a push plan is local until approved, and approval is a separate host-admin call.
  defineMethod({
    name: 'forgeInbox.proposePush',
    permission: 'workspace',
    params: ForgeInboxProposePushParams,
    handler: (params, context): Promise<ForgeInboxPushProposalOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.proposePush(
          {
            scope: scopeOf(params.instanceId),
            runId: params.runId,
            patchProposalId: params.patchProposalId,
            message: params.message
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  }),
  // Why host-admin: the owner pushes with its stored write credential, not the caller's.
  defineMethod({
    name: 'forgeInbox.approvePush',
    permission: 'host-admin',
    params: ForgeInboxApprovePushParams,
    handler: (params, context): Promise<ForgeInboxPushApplyOutcome> => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.approvePush(
          {
            scope: scopeOf(params.instanceId),
            proposalId: params.proposalId,
            expectedHash: params.expectedHash,
            expectedRevision: params.expectedRevision,
            expectedPolicyGeneration: params.expectedPolicyGeneration
          },
          signalOf(context),
          params.ownerHostId
        ))
      }))
    }
  })
]
