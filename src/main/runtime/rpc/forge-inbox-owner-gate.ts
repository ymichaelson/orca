import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../shared/forge-inbox-rpc-errors'
import { ForgeInboxOwnerMismatchError } from '../../forge-inbox/forge-inbox-owner-errors'
import type { ForgeInboxOwnerService } from '../../forge-inbox/forge-inbox-owner-service'
import type { RpcContext } from './core'
import { rpcCallerOperationKey } from './rpc-caller-identity'

/** The owner service when the caller addressed this host's inbox; a mismatch never falls back to local data. */
export function forgeOwnerFor(context: RpcContext, ownerHostId: string): ForgeInboxOwnerService {
  const service = context.runtime.forgeInboxService()
  if (service.ownerHostId() !== ownerHostId) {
    throw new Error(FORGE_INBOX_RPC_ERROR_CODES.ownerMismatch)
  }
  return service
}

/** Read marks follow the host-stamped caller, never a param or the per-connection id. */
export function forgeReaderId(context: RpcContext): string {
  if (!context.caller) {
    throw new Error(FORGE_INBOX_RPC_ERROR_CODES.callerUnidentified)
  }
  return rpcCallerOperationKey(context.caller)
}

/** Backend exceptions can carry paths or secrets, so the caller only learns that the inbox is unavailable. */
export async function guardForgeInbox<T>(code: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(
      error instanceof ForgeInboxOwnerMismatchError
        ? FORGE_INBOX_RPC_ERROR_CODES.ownerMismatch
        : code
    )
  }
}
