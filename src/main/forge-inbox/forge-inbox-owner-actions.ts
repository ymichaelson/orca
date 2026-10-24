import type { ForgeInboxPatchOutcome } from '../../shared/forge-inbox-rpc-types'
import type { ForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeOwnerRunning } from './forge-inbox-owner-running'
import type { ForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import type { ForgeOwnerPushApply } from './forge-inbox-owner-push-apply'
import type { ForgeOwnerPushPropose } from './forge-inbox-owner-push-proposal'

/**
 * Turn and approval ports resolve the running host per call, so a lazy first write opens the
 * ledger before the port names it and a stopped host refuses instead of using a closed one.
 */
export function createForgeOwnerActions(
  resolve: (expectedOwner?: string) => Promise<ForgeOwnerRunning>
) {
  return {
    async discuss(
      request: Parameters<ForgeInboxDiscuss>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ) {
      const state = await resolve(expectedOwner)
      return state.discuss
        ? state.discuss(request, signal)
        : { kind: 'refused' as const, reason: 'host-unavailable' as const }
    },
    async proposePatch(
      request: Parameters<ForgeInboxPatchProducer>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ): Promise<ForgeInboxPatchOutcome> {
      const state = await resolve(expectedOwner)
      return state.proposePatch
        ? state.proposePatch(request, signal)
        : { kind: 'refused' as const, reason: 'host-unavailable' as const }
    },
    async approvePatch(
      request: Parameters<ForgeOwnerRunning['patchApply']>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ): ReturnType<ForgeOwnerRunning['patchApply']> {
      const state = await resolve(expectedOwner)
      return state.patchApply(request, signal)
    },
    async proposePush(
      request: Parameters<ForgeOwnerPushPropose>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ): ReturnType<ForgeOwnerPushPropose> {
      const state = await resolve(expectedOwner)
      return state.pushPropose(request, signal)
    },
    async approvePush(
      request: Parameters<ForgeOwnerPushApply>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ): ReturnType<ForgeOwnerPushApply> {
      const state = await resolve(expectedOwner)
      return state.pushApply(request, signal)
    }
  }
}
