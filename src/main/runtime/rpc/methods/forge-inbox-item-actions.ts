import { ForgeInboxItemParams } from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, guardForgeInbox } from '../forge-inbox-owner-gate'

const UNAVAILABLE = FORGE_INBOX_RPC_ERROR_CODES.unavailable

/** Item writes are owner actions: the host executes the recommendation a person confirmed. */
export const FORGE_INBOX_ITEM_ACTION_METHODS = [
  defineMethod({
    name: 'forgeInbox.mergeItem',
    permission: 'workspace',
    params: ForgeInboxItemParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      const signal = context.signal ?? new AbortController().signal
      return guardForgeInbox(UNAVAILABLE, async () => ({
        ownerHostId: params.ownerHostId,
        ...(await service.mergeItem(
          {
            scope: params.instanceId === undefined ? {} : { instanceId: params.instanceId },
            itemId: params.itemId
          },
          signal
        ))
      }))
    }
  })
]
