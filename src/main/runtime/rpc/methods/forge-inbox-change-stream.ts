import {
  ForgeInboxAckChangesParams,
  ForgeInboxSubscribeChangesParams,
  ForgeInboxUnsubscribeChangesParams
} from '../../../../shared/rpc-contract/forge-inbox-params'
import { FORGE_INBOX_RPC_ERROR_CODES } from '../../../../shared/forge-inbox-rpc-errors'
import { defineMethod, defineStreamingMethod } from '../core'
import { createForgeChangeStream } from '../forge-inbox-change-stream'
import {
  findForgeStream,
  forgeStreamConnectionKey,
  forgeStreamIdPrefix,
  registerForgeStream,
  unregisterForgeStream
} from '../forge-inbox-change-stream-registry'
import { ForgeInboxInvalidCursorError } from '../../../forge-inbox/forge-inbox-owner-errors'
import { forgeOwnerFor, forgeReaderId, guardForgeInbox } from '../forge-inbox-owner-gate'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'

const { unavailable, invalidSubscription, invalidCursor } = FORGE_INBOX_RPC_ERROR_CODES

let streamSeq = 0

export const FORGE_INBOX_CHANGE_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'forgeInbox.subscribeChanges',
    permission: 'workspace',
    params: ForgeInboxSubscribeChangesParams,
    handler: async (params, ctx, emit) => {
      const { runtime, connectionId } = ctx
      const service = forgeOwnerFor(ctx, params.ownerHostId)
      const readerId = forgeReaderId(ctx)
      const scope = params.instanceId === undefined ? {} : { instanceId: params.instanceId }
      const subscriptionId = `${forgeStreamIdPrefix(connectionId)}${++streamSeq}`
      const afterSeq = await guardForgeInbox(
        unavailable,
        () => params.afterSeq ?? service.getClientCursor({ ...scope, readerId })
      )
      let ending = false
      const stream = createForgeChangeStream({
        service,
        ownerHostId: params.ownerHostId,
        scope,
        readerId,
        subscriptionId,
        afterSeq,
        emit,
        end: (reason) => {
          if (ending) {
            return
          }
          ending = true
          // Why finally: a dead sink must still release the registration and the hint listener.
          try {
            emit({ type: 'end', reason })
          } catch {
            // The peer is gone; the cleanup below is the only thing left to do.
          } finally {
            runtime.cleanupSubscription(subscriptionId)
          }
        }
      })
      let markClosed: () => void = () => undefined
      const closed = new Promise<void>((resolve) => (markClosed = resolve))
      const bound = bindStructuredAgentSessionStream(ctx, subscriptionId, () => {
        stream.dispose()
        unregisterForgeStream(runtime, subscriptionId)
        markClosed()
      })
      if (bound.isClosed()) {
        return
      }
      registerForgeStream(runtime, subscriptionId, {
        connectionKey: forgeStreamConnectionKey(connectionId),
        stream
      })
      try {
        // Why re-fence here: the cursor await may have let a lazy open change the owner, and the
        // hint listener below is registered synchronously after this check.
        forgeOwnerFor(ctx, params.ownerHostId)
        await guardForgeInbox(unavailable, () => stream.start())
      } catch (error) {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      }
      await closed
    }
  }),
  defineMethod({
    name: 'forgeInbox.unsubscribeChanges',
    permission: 'workspace',
    params: ForgeInboxUnsubscribeChangesParams,
    handler: (params, { runtime, connectionId, subscriptionRegistrationVersion }) => {
      if (!params.subscriptionId.startsWith(forgeStreamIdPrefix(connectionId))) {
        return { unsubscribed: false }
      }
      // Why the version: a late unsubscribe must not retire a stream registered after it was dispatched.
      return {
        unsubscribed: runtime.cleanupSubscriptionIfOwnedByConnection(
          params.subscriptionId,
          connectionId,
          subscriptionRegistrationVersion
        )
      }
    }
  }),
  defineMethod({
    name: 'forgeInbox.ackChanges',
    permission: 'workspace',
    params: ForgeInboxAckChangesParams,
    handler: async (params, ctx) => {
      const service = forgeOwnerFor(ctx, params.ownerHostId)
      const readerId = forgeReaderId(ctx)
      const stream = findForgeStream(ctx.runtime, params.subscriptionId, ctx.connectionId)
      if (!stream || stream.ownerHostId !== params.ownerHostId || stream.readerId !== readerId) {
        throw new Error(invalidSubscription)
      }
      const key = { ...stream.scope, readerId }
      if (!stream.isAckable(params.seq)) {
        throw new Error(invalidCursor)
      }
      const acked = await guardForgeInbox(unavailable, async () => {
        if (params.seq <= stream.ackedSeq()) {
          return { cursor: service.getClientCursor(key) }
        }
        // Why durable first: the window only opens for a cursor the ledger accepted.
        try {
          const cursor = await service.ackClientCursor(
            { ...key, seq: params.seq },
            params.ownerHostId
          )
          stream.release(params.seq)
          return { cursor }
        } catch (error) {
          // Why only this error: any other backend failure is not a client cursor mistake.
          if (error instanceof ForgeInboxInvalidCursorError) {
            return null
          }
          throw error
        }
      })
      if (acked === null) {
        throw new Error(invalidCursor)
      }
      return acked
    }
  })
]
