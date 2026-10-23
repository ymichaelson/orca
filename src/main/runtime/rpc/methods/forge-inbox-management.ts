import {
  ForgeInboxClearCredentialParams,
  ForgeInboxSetCredentialParams,
  ForgeInboxUpdateConfigParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, guardForgeInbox } from '../forge-inbox-owner-gate'

const { unavailable, credentialUnavailable } = FORGE_INBOX_RPC_ERROR_CODES

// Why failures are mapped: the dispatcher forwards Error.message, and backend or secret-store errors can carry secrets.
export const FORGE_INBOX_MANAGEMENT_METHODS = [
  defineMethod({
    name: 'forgeInbox.updateConfig',
    permission: 'host-admin',
    params: ForgeInboxUpdateConfigParams,
    handler: (params, context) => {
      const { ownerHostId } = params
      const service = forgeOwnerFor(context, ownerHostId)
      return guardForgeInbox(unavailable, async () => ({
        ownerHostId,
        ...(await service.updateConfig(params.expectedRevision, params.config, ownerHostId))
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.setCredential',
    permission: 'accounts-admin',
    params: ForgeInboxSetCredentialParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const { ownerHostId, ...input } = params
      return guardForgeInbox(credentialUnavailable, async () => ({
        ownerHostId,
        ...(await service.setCredential(input, ownerHostId))
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.clearCredential',
    permission: 'accounts-admin',
    params: ForgeInboxClearCredentialParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const { ownerHostId, ...input } = params
      return guardForgeInbox(credentialUnavailable, async () => ({
        ownerHostId,
        ...(await service.clearCredential(input, ownerHostId))
      }))
    }
  })
]
