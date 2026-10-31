import { parseGitlabHook } from './forge-inbox-gitlab-hook-payload'
import { projectEventDecisionFacts } from './forge-inbox-project-event-decision-facts'
import {
  parseProjectPush,
  projectEventFingerprint,
  PROJECT_PUSH_OBJECT_KINDS
} from './forge-inbox-project-event-push'
import type { ForgeItemKind } from './forge-inbox-types'
import { parseWebhookBody } from './forge-inbox-webhook-request'
import { isRecord } from './forge-inbox-rows'

export type ProjectEventSubject = {
  kind: ForgeItemKind
  iid: number
  /** What fired the event, kept apart from the item it is about. */
  trigger: { kind: string; id: number | null; iid?: number }
  /** Set only for a project item, which has no head of its own: what tells one event from the next. */
  fingerprint?: string
}

export type ProjectEventSubjectRefusal =
  | 'invalid-input'
  | 'item-identity-missing'
  | 'event-subject-unsupported'
  | 'event-project-mismatch'

export type ProjectEventSubjectResult =
  | { ok: true; subject: ProjectEventSubject }
  | { ok: false; code: ProjectEventSubjectRefusal }

/** Project-level items are numbered from here, one per delivery, so two triggers never merge. */
export const PROJECT_ITEM_IID = 0

/** The store id of the item a project-level delivery opens: its own row, signed, never 0 or negative. */
export function projectItemIdOf(deliveryId: number): number {
  return PROJECT_ITEM_IID - deliveryId
}

/** The delivery a project-level item was opened for, or null for any other item. */
export function projectItemDeliveryId(iid: number): number | null {
  return iid < PROJECT_ITEM_IID ? -iid : null
}

const HOOK_EVENT_BY_OBJECT_KIND: Record<string, string> = {
  note: 'Note Hook',
  pipeline: 'Pipeline Hook'
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

const refuse = (code: ProjectEventSubjectRefusal): ProjectEventSubjectResult => ({
  ok: false,
  code
})

/**
 * The item a delivery is about, or null when its body names none this project can read. A foreign
 * project's iid is never trusted: a pipeline links to its merge request only when the payload
 * itself proves that request targets the bound project.
 */
export function projectEventSubject(
  body: unknown,
  bindingProjectId: number,
  deliveryId: number
): ProjectEventSubject | null {
  const result = resolveProjectEventSubject(body, bindingProjectId, deliveryId)
  return result.ok ? result.subject : null
}

/** Like `projectEventSubject`, but says why a body has no subject so the refusal can be told apart. */
export function resolveProjectEventSubject(
  body: unknown,
  bindingProjectId: number,
  /** The store row the delivery was admitted as; it names the item a project-level event opens. */
  deliveryId: number,
  unknownDeliveryKey?: string
): ProjectEventSubjectResult {
  if (!(body instanceof Uint8Array)) {
    return refuse('invalid-input')
  }
  const project = parseWebhookBody(Buffer.from(body))
  if (!project.ok) {
    return refuse('invalid-input')
  }
  if (project.projectId !== String(bindingProjectId)) {
    return refuse('event-project-mismatch')
  }
  let facts: Record<string, unknown>
  try {
    facts = projectEventDecisionFacts(body)
  } catch {
    return refuse('invalid-input')
  }
  const triggerKind = typeof facts.kind === 'string' ? facts.kind : ''
  if (triggerKind === '') {
    return refuse('invalid-input')
  }
  if (facts.kind === 'merge_request' || facts.kind === 'issue') {
    const targetError = reportedTargetError(body, facts.kind, bindingProjectId, true)
    if (targetError !== null) {
      return refuse(targetError)
    }
    const iid = positiveInteger(facts.iid)
    return iid === null
      ? refuse('item-identity-missing')
      : { ok: true, subject: { kind: facts.kind, iid, trigger: { kind: triggerKind, id: null } } }
  }
  if (PROJECT_PUSH_OBJECT_KINDS.some((kind) => kind === triggerKind)) {
    return projectPushSubject(body, bindingProjectId, deliveryId)
  }
  if (triggerKind === 'release' || triggerKind === 'deployment') {
    return projectRootEventSubject(body, triggerKind, deliveryId)
  }
  const eventKind = HOOK_EVENT_BY_OBJECT_KIND[triggerKind]
  if (eventKind === undefined) {
    return unknownDeliveryKey === undefined
      ? refuse('event-subject-unsupported')
      : projectSubject(
          triggerKind,
          projectEventFingerprint(['unknown', bindingProjectId, unknownDeliveryKey]),
          deliveryId
        )
  }
  const parsed = parseGitlabHook(eventKind, Buffer.from(body))
  if (!parsed.ok) {
    return refuse(parsed.reason === 'unsupported' ? 'event-subject-unsupported' : 'invalid-input')
  }
  const { hook } = parsed
  if (hook.kind !== 'note' && hook.kind !== 'pipeline') {
    return refuse('event-subject-unsupported')
  }
  if (hook.projectId !== bindingProjectId) {
    return refuse('event-project-mismatch')
  }
  if (hook.kind === 'note') {
    const targetError = reportedTargetError(body, hook.noteable, bindingProjectId, false)
    if (targetError !== null) {
      return refuse(targetError)
    }
    return itemSubject(hook.noteable, hook.iid, { kind: triggerKind, id: hook.noteId })
  }
  const trigger = { kind: triggerKind, id: hook.pipelineId }
  if (hook.mergeRequestIid !== undefined && hook.mergeRequestTargetProjectId === bindingProjectId) {
    return itemSubject('merge_request', hook.mergeRequestIid, trigger)
  }
  return itemSubject('pipeline', hook.pipelineId, trigger)
}

function reportedTargetError(
  body: Uint8Array,
  kind: 'merge_request' | 'issue',
  bindingProjectId: number,
  includeAttributes: boolean
): ProjectEventSubjectRefusal | null {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  if (!isRecord(parsed)) {
    return 'invalid-input'
  }
  const field = kind === 'merge_request' ? 'target_project_id' : 'project_id'
  const objects = includeAttributes ? [parsed[kind], parsed.object_attributes] : [parsed[kind]]
  for (const object of objects) {
    if (!isRecord(object) || !(field in object)) {
      continue
    }
    const projectId = positiveInteger(object[field])
    if (projectId === null) {
      return 'invalid-input'
    }
    if (projectId !== bindingProjectId) {
      return 'event-project-mismatch'
    }
  }
  return null
}

function itemSubject(
  kind: ForgeItemKind,
  iid: number,
  trigger: ProjectEventSubject['trigger']
): ProjectEventSubjectResult {
  return positiveInteger(iid) === null
    ? refuse('item-identity-missing')
    : { ok: true, subject: { kind, iid, trigger } }
}

function projectSubject(
  kind: string,
  fingerprint: string,
  deliveryId: number
): ProjectEventSubjectResult {
  const iid = projectItemIdOf(deliveryId)
  return {
    ok: true,
    subject: { kind: 'project', iid, trigger: { kind, id: null, iid }, fingerprint }
  }
}

function projectRootEventSubject(
  body: Uint8Array,
  kind: 'release' | 'deployment',
  deliveryId: number
): ProjectEventSubjectResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return refuse('invalid-input')
  }
  if (!isRecord(parsed)) {
    return refuse('invalid-input')
  }
  if (kind === 'release') {
    if (
      ('id' in parsed && positiveInteger(parsed.id) === null) ||
      typeof parsed.action !== 'string' ||
      typeof parsed.tag !== 'string' ||
      parsed.tag.length === 0
    ) {
      return refuse('item-identity-missing')
    }
    return projectSubject(
      kind,
      projectEventFingerprint([
        kind,
        parsed.id ?? null,
        parsed.action,
        parsed.tag,
        parsed.name ?? null,
        parsed.description ?? null
      ]),
      deliveryId
    )
  }
  if (
    positiveInteger(parsed.deployment_id) === null ||
    typeof parsed.status !== 'string' ||
    typeof parsed.environment !== 'string'
  ) {
    return refuse('item-identity-missing')
  }
  return projectSubject(
    kind,
    projectEventFingerprint([
      kind,
      parsed.deployment_id,
      parsed.status,
      parsed.environment,
      parsed.ref ?? null
    ]),
    deliveryId
  )
}

function projectPushSubject(
  body: Uint8Array,
  bindingProjectId: number,
  deliveryId: number
): ProjectEventSubjectResult {
  const push = parseProjectPush(body)
  if (push === null) {
    return refuse('invalid-input')
  }
  if (push.projectId === null) {
    return refuse('item-identity-missing')
  }
  if (push.projectId !== bindingProjectId) {
    return refuse('event-project-mismatch')
  }
  return {
    ok: true,
    subject: {
      kind: 'project',
      iid: projectItemIdOf(deliveryId),
      trigger: { kind: push.event, id: null, iid: projectItemIdOf(deliveryId) },
      fingerprint: push.fingerprint
    }
  }
}
