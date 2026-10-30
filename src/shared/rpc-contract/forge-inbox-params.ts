import { z } from 'zod'
import { FORGE_ITEM_HANDLING_STATES } from '../forge-inbox-item-handling'
import { FORGE_ITEM_KINDS } from '../forge-inbox-types'
import { forgeProjectPolicyPatchSchema } from '../forge-inbox-project-policy-patch'
import {
  FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES,
  FORGE_PROJECT_EVENT_QUESTION_STATUSES
} from '../forge-inbox-project-event-question'

// Why a bounded string, not a UUID: the owner mints a UUID, but a host may be pinned to any id.
const OwnerHostId = z.string().min(1).max(128)
const InstanceId = z.string().min(1).max(128)
const RowId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Page = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: RowId.optional()
}
const Owned = { ownerHostId: OwnerHostId, instanceId: InstanceId.optional() }

export const ForgeInboxNoParams = z.strictObject({})
export const ForgeInboxListItemsParams = z.strictObject({
  ...Owned,
  ...Page,
  unreadOnly: z.boolean().optional(),
  archiveView: z.enum(['active', 'archived', 'all']).optional(),
  /** One project path as the ledger recorded it, so the filter cannot be a pattern. */
  projectId: z.string().min(1).max(512).optional(),
  kind: z.enum(FORGE_ITEM_KINDS).optional(),
  /** The derived handling state; the host computes it per item, so this narrows after that read. */
  handling: z.enum(FORGE_ITEM_HANDLING_STATES).optional()
})
export const ForgeInboxListProjectsParams = z.strictObject({ ownerHostId: OwnerHostId })
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
/** A repository id is durable across worktrees; a workspace or client path is never accepted. */
const RepoId = z.string().min(1).max(200)

export const ForgeInboxGetProjectEventPolicyParams = z.strictObject({
  ownerHostId: OwnerHostId,
  repoId: RepoId
})
export const ForgeInboxUpdateProjectEventPolicyParams = z.strictObject({
  ownerHostId: OwnerHostId,
  repoId: RepoId,
  expectedGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  patch: forgeProjectPolicyPatchSchema
})
export const ForgeInboxRetryProjectEventParams = z.strictObject({
  ownerHostId: OwnerHostId,
  repoId: RepoId,
  allowUnprotectedStorage: z.boolean().optional()
})
export const ForgeInboxGetProjectEventActivityParams = z.strictObject({
  ownerHostId: OwnerHostId,
  repoId: RepoId,
  limit: z.number().int().min(1).max(20).optional()
})
export const ForgeInboxRotateProjectEventSecretParams = z.strictObject({
  ownerHostId: OwnerHostId,
  repoId: RepoId,
  allowUnprotectedStorage: z.boolean().optional()
})

export const ForgeInboxListProjectEventQuestionsParams = z.strictObject({
  ownerHostId: OwnerHostId,
  status: z.enum(FORGE_PROJECT_EVENT_QUESTION_STATUSES).optional()
})
/** NUL and the byte bound are refused here so the ledger only ever stores displayable answer text. */
export const ForgeInboxAnswerProjectEventQuestionParams = z.strictObject({
  ownerHostId: OwnerHostId,
  questionId: RowId,
  answer: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.includes('\u0000') &&
        Buffer.byteLength(value, 'utf8') <= FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES,
      'answer must be displayable text within the byte bound'
    )
})

/** One discuss message; the prompt builder quotes it whole, so the cap is shared by both sides. */
export const FORGE_DISCUSS_MAX_MESSAGE_CHARS = 64 * 1024
