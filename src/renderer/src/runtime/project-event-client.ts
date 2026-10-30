import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  ForgeInboxProjectEventActivityView,
  ForgeInboxProjectEventBindingActionOutcome,
  ForgeInboxProjectEventPolicyView,
  ForgeInboxProjectEventPolicyWriteOutcome
} from '../../../shared/forge-inbox-rpc-types'
import type { ForgeProjectPolicyPatch } from '../../../shared/forge-inbox-project-policy-patch'
import type {
  ProjectEventQuestionAnswerOutcome,
  ProjectEventQuestionStatus,
  ProjectEventQuestionView
} from '../../../shared/forge-inbox-project-event-question'
import { callRuntimeRpc } from './runtime-rpc-client'

/** The inbox belongs to the host this window is attached to; in the web client that is the server. */
const HOST_RUNTIME: RuntimeClientTarget = { kind: 'local' }

/** The repo's project event policy and webhook binding as the owner host has them. */
export function readProjectEventPolicy(
  ownerHostId: string,
  repoId: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectEventPolicyView> {
  return callRuntimeRpc<ForgeInboxProjectEventPolicyView>(
    target,
    'forgeInbox.getProjectEventPolicy',
    { ownerHostId, repoId }
  )
}

/** Compare-and-set write: the owner rejects the patch when its generation moved on. */
export function updateProjectEventPolicy(
  ownerHostId: string,
  repoId: string,
  expectedGeneration: number,
  patch: ForgeProjectPolicyPatch,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectEventPolicyWriteOutcome> {
  return callRuntimeRpc<ForgeInboxProjectEventPolicyWriteOutcome>(
    target,
    'forgeInbox.updateProjectEventPolicy',
    { ownerHostId, repoId, expectedGeneration, patch }
  )
}

/** The owner applies its default limit; asking for more than the page shows is not a poll. */
export function readProjectEventActivity(
  ownerHostId: string,
  repoId: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectEventActivityView> {
  return callRuntimeRpc<ForgeInboxProjectEventActivityView>(
    target,
    'forgeInbox.getProjectEventActivity',
    { ownerHostId, repoId }
  )
}

/** Re-runs the check and registration the owner already owns; it never rewrites the policy. */
export function retryProjectEvent(
  ownerHostId: string,
  repoId: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectEventBindingActionOutcome> {
  return callRuntimeRpc<ForgeInboxProjectEventBindingActionOutcome>(
    target,
    'forgeInbox.retryProjectEvent',
    { ownerHostId, repoId }
  )
}

/** Questions the owner host is waiting on; open ones park a delivery until they are answered. */
export function readProjectEventQuestions(
  ownerHostId: string,
  status?: ProjectEventQuestionStatus,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<{ ownerHostId: string; questions: ProjectEventQuestionView[] }> {
  return callRuntimeRpc<{ ownerHostId: string; questions: ProjectEventQuestionView[] }>(
    target,
    'forgeInbox.listProjectEventQuestions',
    { ownerHostId, ...(status === undefined ? {} : { status }) }
  )
}

/** One answer per open question; the owner requeues the parked delivery on success. */
export function answerProjectEventQuestion(
  ownerHostId: string,
  questionId: number,
  answer: string,
  target: RuntimeClientTarget
): Promise<{ ownerHostId: string } & ProjectEventQuestionAnswerOutcome> {
  return callRuntimeRpc<{ ownerHostId: string } & ProjectEventQuestionAnswerOutcome>(
    target,
    'forgeInbox.answerProjectEventQuestion',
    { ownerHostId, questionId, answer }
  )
}

/** Rotation stages a new secret; the old one stays valid only until GitLab accepts it. */
export function rotateProjectEventSecret(
  ownerHostId: string,
  repoId: string,
  input: { allowUnprotectedStorage?: boolean } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectEventBindingActionOutcome> {
  return callRuntimeRpc<ForgeInboxProjectEventBindingActionOutcome>(
    target,
    'forgeInbox.rotateProjectEventSecret',
    { ownerHostId, repoId, ...input }
  )
}
