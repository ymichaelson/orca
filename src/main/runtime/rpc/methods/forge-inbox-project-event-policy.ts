import {
  ForgeInboxGetProjectEventActivityParams,
  ForgeInboxGetProjectEventPolicyParams,
  ForgeInboxRetryProjectEventParams,
  ForgeInboxRotateProjectEventSecretParams,
  ForgeInboxUpdateProjectEventPolicyParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod } from '../core'
import { forgeOwnerFor, guardForgeInbox } from '../forge-inbox-owner-gate'

// Why 'workspace': a repository policy is tuned by the same paired caller that reads its inbox.
export const FORGE_INBOX_PROJECT_EVENT_POLICY_METHODS = [
  defineMethod({
    name: 'forgeInbox.getProjectEventPolicy',
    permission: 'workspace',
    params: ForgeInboxGetProjectEventPolicyParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, () => ({
        ownerHostId: params.ownerHostId,
        repoId: params.repoId,
        policy: service.getProjectEventPolicy(params.repoId, params.ownerHostId),
        binding: service.getProjectEventBinding(params.repoId, params.ownerHostId)
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.updateProjectEventPolicy',
    permission: 'workspace',
    params: ForgeInboxUpdateProjectEventPolicyParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        repoId: params.repoId,
        ...(await service.updateProjectEventPolicy(
          params.repoId,
          params.expectedGeneration,
          params.patch,
          params.ownerHostId
        ))
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.retryProjectEvent',
    permission: 'workspace',
    params: ForgeInboxRetryProjectEventParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        repoId: params.repoId,
        ...(await service.retryProjectEvent(
          params.repoId,
          params.ownerHostId,
          params.allowUnprotectedStorage
        ))
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.getProjectEventActivity',
    permission: 'workspace',
    params: ForgeInboxGetProjectEventActivityParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, () => ({
        ownerHostId: params.ownerHostId,
        repoId: params.repoId,
        ...service.getProjectEventActivity(params.repoId, params.limit, params.ownerHostId)
      }))
    }
  }),
  defineMethod({
    name: 'forgeInbox.rotateProjectEventSecret',
    permission: 'workspace',
    params: ForgeInboxRotateProjectEventSecretParams,
    handler: (params, context) => {
      const service = forgeOwnerFor(context, params.ownerHostId)
      return guardForgeInbox(FORGE_INBOX_RPC_ERROR_CODES.unavailable, async () => ({
        ownerHostId: params.ownerHostId,
        repoId: params.repoId,
        ...(await service.rotateProjectEventSecret(
          params.repoId,
          params.ownerHostId,
          params.allowUnprotectedStorage
        ))
      }))
    }
  })
]
