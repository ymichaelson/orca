import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  ForgeInboxApprovePatchOutcome,
  ForgeInboxCommentApprovalOutcome,
  ForgeInboxConfigView,
  ForgeInboxConfigWriteOutcome,
  ForgeInboxCredentialWriteOutcome,
  ForgeInboxDiscussOutcome,
  ForgeInboxEventsPage,
  ForgeInboxItemDetail,
  ForgeInboxItemsPage,
  ForgeInboxProposalDiffView,
  ForgeInboxProposalPreviewView,
  ForgeInboxProposalRejectOutcome,
  ForgeInboxPushApplyOutcome,
  ForgeInboxRunsPage,
  ForgeInboxStatus
} from '../../../shared/forge-inbox-rpc-types'
import type { ForgeCredentialKind, ForgeInboxConfig } from '../../../shared/forge-inbox-config'
import { callRuntimeRpc } from './runtime-rpc-client'

/** The inbox belongs to the host this window is attached to; in the web client that is the server. */
const HOST_RUNTIME: RuntimeClientTarget = { kind: 'local' }

export function readForgeInboxStatus(
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxStatus> {
  return callRuntimeRpc<ForgeInboxStatus>(target, 'forgeInbox.getStatus')
}

/** Reads are owner-qualified: the host id comes from `getStatus`, never from a workspace. */
export function listForgeInboxItems(
  ownerHostId: string,
  query: { instanceId?: string; unreadOnly?: boolean; limit?: number; cursor?: number } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxItemsPage> {
  return callRuntimeRpc<ForgeInboxItemsPage>(target, 'forgeInbox.listItems', {
    ownerHostId,
    ...query
  })
}

export function readForgeInboxItemDetail(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxItemDetail> {
  return callRuntimeRpc<ForgeInboxItemDetail>(target, 'forgeInbox.getItemDetail', {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

export function listForgeInboxRuns(
  ownerHostId: string,
  query: { instanceId?: string; itemId?: number; limit?: number; cursor?: number } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxRunsPage> {
  return callRuntimeRpc<ForgeInboxRunsPage>(target, 'forgeInbox.listRuns', {
    ownerHostId,
    ...query
  })
}

export function listForgeInboxEvents(
  ownerHostId: string,
  itemId: number,
  query: { instanceId?: string; limit?: number; cursor?: number } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxEventsPage> {
  return callRuntimeRpc<ForgeInboxEventsPage>(target, 'forgeInbox.listEvents', {
    ownerHostId,
    itemId,
    ...query
  })
}

export function readForgeInboxConfig(
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxConfigView> {
  return callRuntimeRpc<ForgeInboxConfigView>(target, 'forgeInbox.getConfig')
}

/** Whole-config writes are revision-checked; callers must resend the revision they just read. */
export function updateForgeInboxConfig(
  ownerHostId: string,
  expectedRevision: number,
  config: ForgeInboxConfig,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxConfigWriteOutcome> {
  return callRuntimeRpc<ForgeInboxConfigWriteOutcome>(target, 'forgeInbox.updateConfig', {
    ownerHostId,
    expectedRevision,
    config
  })
}

export function setForgeInboxCredential(
  ownerHostId: string,
  input: {
    instanceId: string
    kind: ForgeCredentialKind
    expectedRevision: number
    secret: string
    allowUnprotectedStorage?: boolean
  },
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxCredentialWriteOutcome> {
  return callRuntimeRpc<ForgeInboxCredentialWriteOutcome>(target, 'forgeInbox.setCredential', {
    ownerHostId,
    ...input
  })
}

export function clearForgeInboxCredential(
  ownerHostId: string,
  input: { instanceId: string; kind: ForgeCredentialKind; expectedRevision: number },
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxCredentialWriteOutcome> {
  return callRuntimeRpc<ForgeInboxCredentialWriteOutcome>(target, 'forgeInbox.clearCredential', {
    ownerHostId,
    ...input
  })
}

/** The preview is read on demand: list and detail projections deliberately carry no draft body. */
export function readForgeInboxProposal(
  ownerHostId: string,
  proposalId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProposalPreviewView> {
  return callRuntimeRpc<ForgeInboxProposalPreviewView>(target, 'forgeInbox.getProposal', {
    ownerHostId,
    proposalId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

/** The host renders the diff from the base the manifest pins; the client never builds its own. */
export function readForgeInboxProposalDiff(
  ownerHostId: string,
  proposalId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProposalDiffView> {
  return callRuntimeRpc<ForgeInboxProposalDiffView>(target, 'forgeInbox.getProposalDiff', {
    ownerHostId,
    proposalId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

/** The hash and versions are the ones the dialog displayed; the host refuses anything else. */
type ForgeProposalApprovalInput = {
  proposalId: number
  instanceId?: string
  expectedHash: string
  expectedRevision: number
  expectedPolicyGeneration: number
}

export function approveForgeInboxComment(
  ownerHostId: string,
  input: ForgeProposalApprovalInput,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxCommentApprovalOutcome> {
  return callRuntimeRpc<ForgeInboxCommentApprovalOutcome>(target, 'forgeInbox.approveComment', {
    ownerHostId,
    ...input
  })
}

export function approveForgeInboxPatch(
  ownerHostId: string,
  input: ForgeProposalApprovalInput,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxApprovePatchOutcome> {
  return callRuntimeRpc<ForgeInboxApprovePatchOutcome>(target, 'forgeInbox.approvePatch', {
    ownerHostId,
    ...input
  })
}

export function approveForgeInboxPush(
  ownerHostId: string,
  input: ForgeProposalApprovalInput,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxPushApplyOutcome> {
  return callRuntimeRpc<ForgeInboxPushApplyOutcome>(target, 'forgeInbox.approvePush', {
    ownerHostId,
    ...input
  })
}

export function rejectForgeInboxProposal(
  ownerHostId: string,
  proposalId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProposalRejectOutcome> {
  return callRuntimeRpc<ForgeInboxProposalRejectOutcome>(target, 'forgeInbox.rejectProposal', {
    ownerHostId,
    proposalId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

export function discussForgeInboxRun(
  ownerHostId: string,
  input: { runId: number; message: string; instanceId?: string },
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxDiscussOutcome> {
  return callRuntimeRpc<ForgeInboxDiscussOutcome>(target, 'forgeInbox.discuss', {
    ownerHostId,
    ...input
  })
}

export function markForgeInboxItemRead(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<{ ownerHostId: string; marked: boolean }> {
  return callRuntimeRpc<{ ownerHostId: string; marked: boolean }>(target, 'forgeInbox.markRead', {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}
