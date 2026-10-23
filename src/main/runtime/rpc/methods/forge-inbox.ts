import {
  ForgeInboxGetChangesParams,
  ForgeInboxItemParams,
  ForgeInboxListEventsParams,
  ForgeInboxListItemsParams,
  ForgeInboxListRunsParams,
  ForgeInboxNoParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, forgeReaderId, guardForgeInbox } from '../forge-inbox-owner-gate'
import {
  FORGE_INBOX_PROPOSAL_ACTION_METHODS,
  FORGE_INBOX_PROPOSAL_READ_METHODS
} from './forge-inbox-actions'
import { FORGE_INBOX_CHANGE_STREAM_METHODS } from './forge-inbox-change-stream'
import { FORGE_INBOX_MANAGEMENT_METHODS } from './forge-inbox-management'
import { FORGE_INBOX_PROJECT_POLICY_METHODS } from './forge-inbox-project-policy'

const UNAVAILABLE = FORGE_INBOX_RPC_ERROR_CODES.unavailable

function scopeOf(instanceId: string | undefined) {
  return instanceId === undefined ? {} : { instanceId }
}

// Why permission 'workspace': ordinary reads and read marks need no admin right; admin lives in management.
const FORGE_INBOX_READ_METHODS = [
  defineMethod({
    name: 'forgeInbox.getStatus',
    permission: 'workspace',
    params: ForgeInboxNoParams,
    handler: (_, context) => {
      const service = context.runtime.forgeInboxServiceIfAttached()
      if (!service) {
        return { ownerHostId: null, available: false, phase: 'unattached' as const }
      }
      return guardForgeInbox(UNAVAILABLE, () => {
        const status = service.status()
        return {
          ownerHostId: service.ownerHostId(),
          available: status.phase === 'running',
          ...status
        }
      })
    }
  }),
  defineMethod({
    name: 'forgeInbox.getConfig',
    permission: 'workspace',
    params: ForgeInboxNoParams,
    handler: (_, context) => {
      const service = context.runtime.forgeInboxService()
      return guardForgeInbox(UNAVAILABLE, () => {
        const { hostId, ...rest } = service.getConfig()
        return { ownerHostId: hostId, ...rest }
      })
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
          ...pageOf(params)
        })
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
  ...FORGE_INBOX_PROPOSAL_READ_METHODS,
  ...FORGE_INBOX_PROPOSAL_ACTION_METHODS,
  ...FORGE_INBOX_CHANGE_STREAM_METHODS,
  ...FORGE_INBOX_PROJECT_POLICY_METHODS,
  ...FORGE_INBOX_MANAGEMENT_METHODS
]
