import { ForgeInboxUpdateProjectPolicyParams } from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, guardForgeInbox } from '../forge-inbox-owner-gate'

// Why 'workspace': authorization is host-wide, so a paired standard caller may tune a project's policy.
export const FORGE_INBOX_PROJECT_POLICY_METHODS = [
  defineMethod({
    name: 'forgeInbox.updateProjectPolicy',
    permission: 'workspace',
    params: ForgeInboxUpdateProjectPolicyParams,
    handler: (params, context) => {
      const { ownerHostId, expectedRevision, ...target } = params
      const service = forgeOwnerFor(context, ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, async () => ({
        ownerHostId,
        ...(await service.updateProjectPolicy(expectedRevision, target, ownerHostId))
      }))
    }
  })
]
