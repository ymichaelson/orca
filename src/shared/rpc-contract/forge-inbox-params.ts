import { z } from 'zod'
import { forgeProjectPolicyPatchSchema } from '../forge-inbox-project-policy-patch'
import { FORGE_CREDENTIAL_KINDS, FORGE_CREDENTIAL_MAX_BYTES } from '../forge-inbox-config'
import {
  FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS,
  FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS,
  FORGE_PATCH_REQUEST_MAX_PATHS,
  FORGE_PATCH_REQUEST_MAX_PATH_CHARS,
  hasControlCharacter
} from '../forge-patch-request'

// Why a bounded string, not a UUID: the owner mints a UUID, but a host may be pinned to any id.
const OwnerHostId = z.string().min(1).max(128)
const InstanceId = z.string().min(1).max(128)
const RowId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Page = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: RowId.optional()
}
const Owned = { ownerHostId: OwnerHostId, instanceId: InstanceId.optional() }
const CredentialTarget = {
  ownerHostId: OwnerHostId,
  instanceId: InstanceId,
  kind: z.enum(FORGE_CREDENTIAL_KINDS),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}

export const ForgeInboxNoParams = z.strictObject({})
export const ForgeInboxListItemsParams = z.strictObject({
  ...Owned,
  ...Page,
  unreadOnly: z.boolean().optional()
})
export const ForgeInboxItemParams = z.strictObject({ ...Owned, itemId: RowId })
export const ForgeInboxListRunsParams = z.strictObject({
  ...Owned,
  ...Page,
  itemId: RowId.optional()
})
export const ForgeInboxListEventsParams = z.strictObject({ ...Owned, ...Page, itemId: RowId })
export const ForgeInboxGetChangesParams = z.strictObject({
  ...Owned,
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: Page.limit
})
export const ForgeInboxUpdateConfigParams = z.strictObject({
  ownerHostId: OwnerHostId,
  expectedRevision: CredentialTarget.expectedRevision,
  config: z.unknown()
})
export const ForgeInboxSetCredentialParams = z.strictObject({
  ...CredentialTarget,
  // Why no trim: a pasted secret is stored byte-exact or refused, never silently altered.
  secret: z
    .string()
    .max(FORGE_CREDENTIAL_MAX_BYTES)
    .regex(/^[\x21-\x7e]+$/),
  allowUnprotectedStorage: z.boolean().optional()
})
export const ForgeInboxClearCredentialParams = z.strictObject(CredentialTarget)
export const ForgeInboxSubscribeChangesParams = z.strictObject({
  ownerHostId: OwnerHostId,
  instanceId: InstanceId.optional(),
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
})
export const ForgeInboxUnsubscribeChangesParams = z.strictObject({
  subscriptionId: z.string().min(1).max(256)
})
export const ForgeInboxAckChangesParams = z.strictObject({
  ownerHostId: OwnerHostId,
  subscriptionId: z.string().min(1).max(256),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})
export const ForgeInboxUpdateProjectPolicyParams = z.strictObject({
  ownerHostId: OwnerHostId,
  instanceId: InstanceId,
  projectId: z.string().min(1).max(128),
  expectedRevision: CredentialTarget.expectedRevision,
  patch: forgeProjectPolicyPatchSchema
})

const ProposalId = { ...Owned, proposalId: RowId }

export const ForgeInboxProposalParams = z.strictObject(ProposalId)

/** Approval binds the draft the client displayed: its hash and the versions it was made under. */
export const ForgeInboxApproveCommentParams = z.strictObject({
  ...ProposalId,
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  expectedRevision: RowId,
  expectedPolicyGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})

export const ForgeInboxRejectProposalParams = z.strictObject(ProposalId)

/** One discuss message; the prompt builder quotes it whole, so the cap is shared by both sides. */
export const FORGE_DISCUSS_MAX_MESSAGE_CHARS = 64 * 1024

export const ForgeInboxDiscussParams = z.strictObject({
  ...Owned,
  runId: RowId,
  message: z.string().min(1).max(FORGE_DISCUSS_MAX_MESSAGE_CHARS)
})

/** No control characters: these become a SQLite key and filesystem paths, never prompt text. */
const controlFree = (schema: z.ZodString) =>
  schema.refine((value) => !hasControlCharacter(value), 'control characters are not allowed')

/** The same intent the claim digests, so a retry that reorders the paths is the same request. */
export const ForgeInboxProposePatchParams = z.strictObject({
  ...Owned,
  runId: RowId,
  operationId: controlFree(z.string().min(1).max(FORGE_PATCH_REQUEST_MAX_IDENTIFIER_CHARS)),
  message: z.string().min(1).max(FORGE_PATCH_REQUEST_MAX_MESSAGE_CHARS),
  paths: z
    .array(controlFree(z.string().min(1).max(FORGE_PATCH_REQUEST_MAX_PATH_CHARS)))
    .max(FORGE_PATCH_REQUEST_MAX_PATHS)
    .optional()
})
