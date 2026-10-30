import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import {
  isForgeInboxNotificationClickTarget,
  type ForgeInboxNotificationSubject
} from '../../shared/forge-inbox-notification-subject'
import { notificationSourceForOwner } from '../../shared/notification-source'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { forgeNotificationCopy } from '../forge-inbox/forge-inbox-notification-dispatch'

type RemoteForgeNotification = {
  subject: ForgeInboxNotificationSubject
  notificationId?: string
  attentionKey?: string
  notificationEpoch?: string
  notificationSeq?: number
}

export function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parseRemoteForgeNotification(value: unknown): RemoteForgeNotification | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'notification' ||
    !('source' in value) ||
    value.source !== 'forge-inbox' ||
    !('forgeInbox' in value) ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    value.title.length > 4096 ||
    !('body' in value) ||
    typeof value.body !== 'string' ||
    value.body.length > 4096
  ) {
    return null
  }
  const target = { subject: value.forgeInbox, executionHostId: 'local' as const }
  if (!isForgeInboxNotificationClickTarget(target)) {
    return null
  }
  const raw = target.subject
  if (
    !boundedString(raw.ownerId) ||
    !boundedString(raw.instanceId) ||
    (raw.trigger !== undefined && !boundedString(raw.trigger)) ||
    (raw.eventId !== undefined && !positiveInteger(raw.eventId)) ||
    (raw.runId !== undefined && !positiveInteger(raw.runId)) ||
    (raw.proposalId !== undefined && !positiveInteger(raw.proposalId)) ||
    ('notificationEpoch' in value &&
      value.notificationEpoch !== undefined &&
      !boundedString(value.notificationEpoch)) ||
    ('notificationSeq' in value &&
      value.notificationSeq !== undefined &&
      !positiveInteger(value.notificationSeq)) ||
    ('notificationId' in value &&
      value.notificationId !== undefined &&
      !boundedString(value.notificationId)) ||
    ('attentionKey' in value &&
      value.attentionKey !== undefined &&
      !boundedString(value.attentionKey))
  ) {
    return null
  }
  const subject: ForgeInboxNotificationSubject = {
    ownerId: raw.ownerId,
    instanceId: raw.instanceId,
    itemId: raw.itemId,
    reason: raw.reason,
    ...(raw.eventId !== undefined ? { eventId: raw.eventId } : {}),
    ...(raw.runId !== undefined ? { runId: raw.runId } : {}),
    ...(raw.proposalId !== undefined ? { proposalId: raw.proposalId } : {}),
    ...(raw.trigger !== undefined ? { trigger: raw.trigger } : {})
  }
  return {
    subject,
    ...('notificationId' in value && boundedString(value.notificationId)
      ? { notificationId: value.notificationId }
      : {}),
    ...('attentionKey' in value && boundedString(value.attentionKey)
      ? { attentionKey: value.attentionKey }
      : {}),
    ...('notificationEpoch' in value && boundedString(value.notificationEpoch)
      ? { notificationEpoch: value.notificationEpoch }
      : {}),
    ...('notificationSeq' in value && positiveInteger(value.notificationSeq)
      ? { notificationSeq: value.notificationSeq }
      : {})
  }
}

export function remoteForgeInboxNotification(
  environment: KnownRuntimeEnvironment,
  event: RemoteForgeNotification
): NotificationDispatchRequest {
  const executionHostId = toRuntimeExecutionHostId(environment.id)
  const subject = event.subject
  const identity = JSON.stringify([subject.ownerId, subject.instanceId, subject.itemId])
  const notificationSourceId = notificationSourceForOwner(
    { executionHostId, runtimeEnvironmentId: environment.id },
    { runtimeEnvironments: [environment] }
  )
  const notificationId =
    event.notificationId ??
    JSON.stringify([
      subject.ownerId,
      subject.instanceId,
      subject.itemId,
      subject.reason,
      subject.eventId,
      subject.runId,
      subject.proposalId,
      subject.trigger
    ])
  return {
    source: 'forge-inbox',
    ...(notificationSourceId ? { notificationSourceId } : {}),
    notificationId: JSON.stringify([environment.id, notificationId]),
    attentionKey: JSON.stringify([environment.id, event.attentionKey ?? identity]),
    forgeInbox: { subject, executionHostId, ...forgeNotificationCopy(subject.reason) }
  }
}
