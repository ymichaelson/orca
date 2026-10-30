import {
  ForgeInboxGetChangesParams,
  ForgeInboxItemParams,
  ForgeInboxListEventsParams,
  ForgeInboxListItemsParams,
  ForgeInboxListProjectsParams,
  ForgeInboxListRunsParams,
  ForgeInboxNoParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import type { ForgeInboxOwnerService } from '../../../forge-inbox/forge-inbox-owner-service'
import { defineMethod } from '../core'
import { forgeOwnerFor, forgeReaderId, guardForgeInbox } from '../forge-inbox-owner-gate'
import { FORGE_INBOX_CHANGE_STREAM_METHODS } from './forge-inbox-change-stream'
import { FORGE_INBOX_PROJECT_EVENT_POLICY_METHODS } from './forge-inbox-project-event-policy'
import { FORGE_INBOX_PROJECT_EVENT_QUESTION_METHODS } from './forge-inbox-project-event-questions'

const UNAVAILABLE = FORGE_INBOX_RPC_ERROR_CODES.unavailable

function scopeOf(instanceId: string | undefined) {
  return instanceId === undefined ? {} : { instanceId }
}

const UNATTACHED_STATUS = { ownerHostId: null, available: false, phase: 'unattached' as const }

function statusPayload(service: ForgeInboxOwnerService) {
  const status = service.status()
  return {
    ownerHostId: service.ownerHostId(),
    available: status.phase === 'running',
    ...status
  }
}

// Why permission 'workspace': ordinary reads and read marks need no admin right; admin lives in management.
const FORGE_INBOX_READ_METHODS = [
  defineMethod({
    name: 'forgeInbox.getStatus',
    permission: 'workspace',
    params: ForgeInboxNoParams,
    handler: (_, context) => {
      const service = context.runtime.forgeInboxServiceIfAttached()
      return service
        ? guardForgeInbox(UNAVAILABLE, () => statusPayload(service))
        : UNATTACHED_STATUS
    }
  }),
  defineMethod({
    name: 'forgeInbox.listItems',
    permission: 'workspace',
    params: ForgeInboxListItemsParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const clientId = forgeReaderId(context)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        ...service.listItems({
          ...scopeOf(params.instanceId),
          clientId,
          ...(params.unreadOnly === undefined ? {} : { unreadOnly: params.unreadOnly }),
          ...(params.archiveView === undefined ? {} : { archiveView: params.archiveView }),
          ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.handling === undefined ? {} : { handling: params.handling }),
          ...pageOf(params)
        })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.listProjects',
    permission: 'workspace',
    params: ForgeInboxListProjectsParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        projects: service.listProjects()
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.getItemDetail',
    permission: 'workspace',
    params: ForgeInboxItemParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const clientId = forgeReaderId(context)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        detail: service.getItemDetail(scopeOf(params.instanceId), params.itemId, clientId)
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.listRuns',
    permission: 'workspace',
    params: ForgeInboxListRunsParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        ...service.listRuns(scopeOf(params.instanceId), {
          ...(params.itemId === undefined ? {} : { itemId: params.itemId }),
          ...pageOf(params)
        })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.listEvents',
    permission: 'workspace',
    params: ForgeInboxListEventsParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        ...service.listEvents(scopeOf(params.instanceId), {
          itemId: params.itemId,
          ...pageOf(params)
        })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.getChanges',
    permission: 'workspace',
    params: ForgeInboxGetChangesParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        ...service.listChanges(scopeOf(params.instanceId), {
          afterSeq: params.afterSeq,
          ...(params.limit === undefined ? {} : { limit: params.limit })
        })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.markRead',
    permission: 'workspace',
    params: ForgeInboxItemParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const clientId = forgeReaderId(context)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        marked: service.markRead(scopeOf(params.instanceId), { clientId, itemId: params.itemId })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.archiveItem',
    permission: 'workspace',
    params: ForgeInboxItemParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const clientId = forgeReaderId(context)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        applied: service.archiveItem(scopeOf(params.instanceId), {
          clientId,
          itemId: params.itemId
        })
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.unarchiveItem',
    permission: 'workspace',
    params: ForgeInboxItemParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const clientId = forgeReaderId(context)
      return guardForgeInbox(UNAVAILABLE, () => ({
        ownerHostId: params.ownerHostId,
        applied: service.unarchiveItem(scopeOf(params.instanceId), {
          clientId,
          itemId: params.itemId
        })
      }))
    }
  })
]

// Why separate: retryReceiver mutates the listener socket, unlike the pure read group.
const FORGE_INBOX_RECEIVER_METHODS = [
  defineMethod({
    name: 'forgeInbox.retryReceiver',
    permission: 'workspace',
    params: ForgeInboxNoParams,
    handler: async (_, context) => {
      const service = context.runtime.forgeInboxServiceIfAttached()
      return service
        ? guardForgeInbox(UNAVAILABLE, async () => {
            // Why: a stopped or failed-open owner cannot reconcile; report its real phase instead.
            if (service.status().phase === 'running') {
              await service.reconcileReceiverSettings()
            }
            return statusPayload(service)
          })
        : UNATTACHED_STATUS
    }
  })
]

function pageOf(params: { limit?: number; cursor?: number }) {
  return {
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor })
  }
}

export const FORGE_INBOX_METHODS = [
  ...FORGE_INBOX_READ_METHODS,
  ...FORGE_INBOX_RECEIVER_METHODS,
  ...FORGE_INBOX_CHANGE_STREAM_METHODS,
  ...FORGE_INBOX_PROJECT_EVENT_POLICY_METHODS,
  ...FORGE_INBOX_PROJECT_EVENT_QUESTION_METHODS
]
