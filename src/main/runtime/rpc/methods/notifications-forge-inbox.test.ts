import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FORGE_INBOX_NOTIFICATION_READER_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  createHarness,
  flush,
  notification,
  registration
} from '../../push/push-dispatcher.test-fixture'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { NOTIFICATION_METHODS } from './notifications'

const Replay = z.object({
  notifications: z.array(
    z.object({
      source: z.string(),
      forgeInbox: z.unknown().optional(),
      executionHost: z.unknown().optional()
    })
  )
})

const FORGE_SUBJECT = {
  ownerId: 'owner-uuid',
  instanceId: 'gitlab-main',
  itemId: 12,
  reason: 'review-request'
} as const

function createHost() {
  const runtime = new OrcaRuntimeService()
  const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })
  const request = (method: string, params: object = {}) => ({
    id: `req-${method}`,
    authToken: 'token',
    method,
    params
  })
  const forgeEvent = () =>
    runtime.dispatchMobileNotification({
      type: 'notification',
      source: 'forge-inbox',
      title: 'Review requested',
      body: '',
      notificationId: 'forge:owner-uuid:12:review-request',
      attentionKey: 'forge:owner-uuid:gitlab-main:12',
      forgeInbox: FORGE_SUBJECT
    })
  const agentEvent = () =>
    runtime.dispatchMobileNotification({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Claude finished',
      body: '',
      worktreeId: 'wt-1'
    })
  return { runtime, dispatcher, request, forgeEvent, agentEvent }
}

function connection(clientCapabilities: readonly string[]): RpcDispatchStreamingOptions {
  return { connectionId: 'conn-1', clientKind: 'mobile', clientCapabilities }
}

async function liveSources(clientCapabilities: readonly string[]): Promise<string[]> {
  const host = createHost()
  const sources: string[] = []
  let subscriptionId = ''
  const done = host.dispatcher.dispatchStreaming(
    host.request('notifications.subscribe'),
    (frame) => {
      const result = JSON.parse(frame).result
      if (result?.type === 'ready') {
        subscriptionId = result.subscriptionId
      } else if (result?.type === 'notification') {
        sources.push(result.source)
      }
    },
    connection(clientCapabilities)
  )
  await Promise.resolve()
  host.agentEvent()
  host.forgeEvent()
  await host.dispatcher.dispatch(
    host.request('notifications.unsubscribe', { subscriptionId }),
    connection(clientCapabilities)
  )
  await done
  return sources
}

async function replayedSources(clientCapabilities: readonly string[]) {
  const host = createHost()
  host.agentEvent()
  host.forgeEvent()
  const reply = await host.dispatcher.dispatch(
    host.request('notifications.getMissedSince', {
      lastSeenSeq: 0,
      epoch: host.runtime.getMobileNotificationEpoch()
    }),
    connection(clientCapabilities)
  )
  if (!('result' in reply)) {
    throw new Error('replay failed')
  }
  return Replay.parse(reply.result).notifications
}

describe('forge inbox notifications over the notification RPC', () => {
  it('streams ordinary agent events to every client but Forge events only to a capable reader', async () => {
    expect(await liveSources([])).toEqual(['agent-task-complete'])
    expect(await liveSources(['agent-session.structured.v1'])).toEqual(['agent-task-complete'])
    expect(await liveSources([FORGE_INBOX_NOTIFICATION_READER_CAPABILITY])).toEqual([
      'agent-task-complete',
      'forge-inbox'
    ])
  })

  it('replays missed events through the same authenticated capability gate', async () => {
    const old = await replayedSources([])
    expect(old.map((e) => e.source)).toEqual(['agent-task-complete'])
    const capable = await replayedSources([FORGE_INBOX_NOTIFICATION_READER_CAPABILITY])
    expect(capable.map((e) => e.source)).toEqual(['agent-task-complete', 'forge-inbox'])
    expect(capable[1]).toMatchObject({ forgeInbox: FORGE_SUBJECT })
    expect(capable[1].executionHost).toBeUndefined()
  })

  it('ignores a capability asserted in the request instead of the connection', async () => {
    const host = createHost()
    host.forgeEvent()
    const reply = await host.dispatcher.dispatch(
      host.request('notifications.getMissedSince', {
        lastSeenSeq: 0,
        epoch: host.runtime.getMobileNotificationEpoch(),
        clientCapabilities: [FORGE_INBOX_NOTIFICATION_READER_CAPABILITY],
        forgeInbox: true
      }),
      connection([])
    )
    expect('result' in reply ? Replay.parse(reply.result).notifications : null).toEqual([])
  })
})

describe('forge inbox notifications and the phone push gateway', () => {
  it('sends an agent event to the gateway but never builds a payload for a Forge event', async () => {
    const harness = createHarness({
      devices: [{ deviceId: 'phone-1', pushRegistration: registration() }]
    })

    harness.dispatcher.enqueue(notification())
    await flush()
    expect(harness.sends).toHaveLength(1)

    harness.dispatcher.enqueue(
      notification({
        source: 'forge-inbox',
        notificationId: 'forge:owner:1:review-request',
        notificationSeq: 8,
        forgeInbox: FORGE_SUBJECT
      })
    )
    await flush()
    expect(harness.sends).toHaveLength(1)
  })
})
