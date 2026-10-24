import type {
  ForgeChange,
  ForgeEvent,
  ForgeItem,
  ForgePage,
  ForgeProposal,
  ForgeProposalStatus,
  ForgeRevision,
  ForgeRun
} from './forge-inbox-types'
import type {
  ForgeCredentialProtection,
  ForgeCredentialStatus,
  ForgeInboxConfig
} from './forge-inbox-config'
import type {
  ForgePatchApplyFailureReason,
  ForgePatchApprovalRefusal,
  ForgePatchProduceRefusal,
  ForgePatchRequestFailureReason,
  ForgePatchRequestInterruptedReason,
  ForgePatchRequestUnverifiableReason
} from './forge-patch-request'
import type {
  ForgePushApplyRefusal,
  ForgePushApprovalRefusal,
  ForgePushFailureReason,
  ForgePushProposalRefusal
} from './forge-push'
export type ForgeInboxPhase = 'new' | 'running' | 'stopped'

export type ForgeInboxListenerView = {
  enabled: boolean
  listening: boolean
  port: number | null
  error: string | null
}

export type ForgeInboxWorkView = {
  pending: number
  needsAuth: number
  nextAttemptAtMs: number | null
  draining: boolean
}

/** A host with no attached runtime capability answers only the unattached variant. */
export type ForgeInboxStatus =
  | { ownerHostId: null; available: false; phase: 'unattached' }
  | {
      ownerHostId: string
      available: boolean
      phase: ForgeInboxPhase
      running: boolean
      dormant: boolean
      listener: ForgeInboxListenerView
      work: ForgeInboxWorkView
    }

/** Run text can come from a backend, so only allowlisted reasons and error codes leave the host. */
export type ForgeRunView = Omit<ForgeRun, 'error' | 'reason'> & {
  reason: string | null
  errorCode: string | null
}

/** Raw proposal bodies hold generated text and tool input; clients get status and versions only. */
export type ForgeProposalView = Omit<ForgeProposal, 'body'>

export type ForgeItemDetailView = {
  item: ForgeItem
  revisions: ForgeRevision[]
  runs: ForgeRunView[]
  proposals: ForgeProposalView[]
}

export type ForgeInboxItemsPage = ForgePage<ForgeItem> & { ownerHostId: string }
export type ForgeInboxRunsPage = ForgePage<ForgeRunView> & { ownerHostId: string }
export type ForgeInboxEventsPage = ForgePage<ForgeEvent> & { ownerHostId: string }

export type ForgeInboxChangesPage = {
  ownerHostId: string
  changes: ForgeChange[]
  nextSeq: number
  hasMore: boolean
}

export type ForgeInboxItemDetail = { ownerHostId: string; detail: ForgeItemDetailView | null }

export type ForgeInboxConfigView = {
  ownerHostId: string
  configRevision: number
  schemaVersion: number
  config: ForgeInboxConfig
  credentials: ForgeCredentialStatus[]
}

export type ForgeInboxConfigWriteOutcome = { ownerHostId: string } & (
  | { ok: true; configRevision: number }
  | { ok: false; reason: 'stale-revision'; configRevision: number }
  | { ok: false; reason: 'invalid-config'; message: string }
  | { ok: false; reason: 'instance-origin-conflict'; instanceId: string }
)

export type ForgeInboxCredentialWriteOutcome = { ownerHostId: string } & (
  | { ok: true; configRevision: number; protection: ForgeCredentialProtection | null }
  | { ok: false; reason: 'stale-revision'; configRevision: number }
  | { ok: false; reason: 'unknown-instance' | 'invalid-secret' }
  | { ok: false; reason: 'unprotected-storage'; gap: string }
)

/** Fields every proposal preview carries; the draft itself is only shown through one of the kinds. */
export type ForgeProposalPreviewBase = {
  proposalId: number
  status: ForgeProposalStatus
  revision: number
  policyGeneration: number
  createdAt: number
  resolvedAt: number | null
}

export type ForgeCommentProposalTarget = {
  instanceId: string
  projectId: string
  kind: 'merge_request' | 'issue'
  iid: number
}

/** The exact comment the owner approves; `hash` is what the approval is bound to. */
export type ForgeCommentProposalPreview = ForgeProposalPreviewBase & {
  kind: 'comment'
  hash: string
  target: ForgeCommentProposalTarget
  headSha: string | null
  body: string
}

/** File contents stay on the host: the list is metadata only, so this build can show but not approve it. */
export type ForgePatchProposalFileView = {
  op: 'create' | 'update' | 'delete'
  path: string
  contentBytes: number
  baseSha256: string | null
  resultSha256: string | null
}

export type ForgePatchProposalPreview = ForgeProposalPreviewBase & {
  kind: 'patch'
  hash: string
  target: { instanceId: string; projectId: string }
  baseSha: string
  branch: string
  files: ForgePatchProposalFileView[]
}

export type ForgePushProposalPreview = ForgeProposalPreviewBase & {
  kind: 'push'
  hash: string
  target: { instanceId: string; projectId: string }
  branch: string
  expectedHeadSha: string
  commitSha: string
  message: string
}

/** A body this build cannot parse: it can be rejected, never approved. */
export type ForgeUnknownProposalPreview = ForgeProposalPreviewBase & {
  kind: 'unknown'
  hash: null
}

export type ForgeProposalPreview =
  | ForgeCommentProposalPreview
  | ForgePatchProposalPreview
  | ForgePushProposalPreview
  | ForgeUnknownProposalPreview

export type ForgeInboxProposalPreviewView = {
  ownerHostId: string
  proposal: ForgeProposalPreview | null
}

/** Why the host will not render the exact diff; none of them means the proposal changed. */
export type ForgePatchDiffFailure =
  | 'not-a-patch'
  | 'base-missing'
  | 'base-unexpected'
  | 'base-mismatch'
  | 'base-unavailable'
  | 'base-unsupported'
  | 'diff-too-large'

export type ForgeProposalDiffOutcome =
  | { ok: true; hash: string; text: string }
  | { ok: false; reason: ForgePatchDiffFailure }

export type ForgeInboxProposalDiffView = {
  ownerHostId: string
  /** Null when the proposal is not in the addressed instance; anything else explains itself. */
  diff: ForgeProposalDiffOutcome | null
}

/** What can stop an otherwise valid approval; a refusal never means a write happened. */
export type ForgeCommentApprovalFailure =
  | 'not-found'
  | 'not-pending'
  | 'stale'
  | 'not-a-comment'
  | 'draft-mismatch'
  | 'head-unavailable'
  | 'head-moved'
  | 'not-approved'
  | 'not-authorised'
  | 'cancelled'
  | 'delivery-failed'
  | 'delivery-unconfirmed'
  | 'marker-ambiguous'
  | 'marker-not-found'
  | 'marker-unavailable'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'too-large'
  | 'bad-response'
  | 'network'
  | 'stale-config'
  | 'no-credential'

export type ForgeCommentApprovalOutcome =
  | { ok: true; receiptId: number; noteId: number | null }
  | { ok: false; reason: ForgeCommentApprovalFailure }

export type ForgeInboxCommentApprovalOutcome = { ownerHostId: string } & ForgeCommentApprovalOutcome

export type ForgeInboxProposalRejectOutcome = { ownerHostId: string } & (
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'not-pending' }
)

export type ForgeDiscussRefusal =
  | 'message-empty'
  | 'message-too-large'
  | 'run-missing'
  | 'run-not-analysed'
  | 'project-unavailable'
  | 'session-missing'
  | 'session-not-protected'
  /** This host wired no record reader: it cannot prove the session, so it does not guess. */
  | 'host-unavailable'
  | 'send-refused'

/** `unknown` means the turn was handed over but its answer could not be proven; never a blank reply. */
export type ForgeInboxDiscussOutcome = { ownerHostId: string } & (
  | { kind: 'reply'; sessionId: string; text: string }
  | { kind: 'unknown'; sessionId: string }
  | { kind: 'refused'; reason: ForgeDiscussRefusal }
)

/** A host that wired no producer refuses; it never reports a proposal it did not make. */
export type ForgeInboxPatchRefusal = ForgePatchProduceRefusal | 'host-unavailable'

/** Producing writes nothing to GitLab: the answer is a local proposal, a coded failure, or a refusal. */
export type ForgeInboxPatchOutcome =
  | { kind: 'proposal'; proposalId: number; requestId: number }
  | { kind: 'in-progress' }
  | { kind: 'failed'; reason: ForgePatchRequestFailureReason }
  | {
      kind: 'unverifiable'
      reason: ForgePatchRequestUnverifiableReason | ForgePatchRequestInterruptedReason
    }
  | { kind: 'refused'; reason: ForgeInboxPatchRefusal }

export type ForgeInboxProposePatchOutcome = { ownerHostId: string } & ForgeInboxPatchOutcome

/** Approval either writes the exact approved tree locally or names why it refused; never both. */
export type ForgeInboxPatchApplyOutcome =
  | { ok: true; receiptId: number; written: string[]; removed: string[] }
  | {
      ok: false
      reason: ForgePatchApprovalRefusal | ForgePatchApplyFailureReason
      /** Present once a receipt exists, so a failed attempt is traceable rather than silent. */
      receiptId?: number
    }

export type ForgeInboxApprovePatchOutcome = { ownerHostId: string } & ForgeInboxPatchApplyOutcome

/** A push plan is local until approved; the host answers with the exact commit it would create. */
export type ForgeInboxPushProposalOutcome = { ownerHostId: string } & (
  | { kind: 'proposal'; proposalId: number; hash: string; commitSha: string; treeSha: string }
  | { kind: 'refused'; reason: ForgePushProposalRefusal }
)

/** Approval pushes at most once; an unconfirmed remote answer keeps its receipt and is never replayed. */
export type ForgeInboxPushApplyOutcome = { ownerHostId: string } & (
  | { ok: true; receiptId: number; branch: string; commitSha: string }
  | {
      ok: false
      reason:
        | ForgePushApprovalRefusal
        | ForgePushApplyRefusal
        | ForgePushFailureReason
        | 'unconfirmed'
      /** Present once a receipt exists, so a failed or unknown attempt stays traceable. */
      receiptId?: number
    }
)
