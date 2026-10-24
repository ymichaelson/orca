// The real host ignores a send envelope's expectedRuntimeFence, so the protected turn's own
// synchronous lease read is what keeps a stale fence from reaching handoff.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { appendAgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  sendForgeProtectedSessionTurn,
  type ForgeProtectedSessionTurnHost
} from './forge-inbox-protected-session-turn'

const OPERATION_ID = /^\d{13}-[0-9a-f]{32}$/

let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: ReturnType<typeof hostTestState>['dispatch']

beforeEach(() => {
  ;({ store, host, dispatch } = hostTestState())
})

/** A resumed owner at a later fence, as a real restart would leave the record. */
function moveFence(fence: number): Promise<unknown> {
  return store.transitionHandoff(SESSION, (record) => {
    const head = record.providerHandleChain.at(-1)
    if (!head) {
      throw new Error('session has no provider handle')
    }
    const link = {
      linkId: `link-${fence}`,
      handle: head.handle,
      origin: 'resumed' as const,
      mintedAtFence: fence,
      observedAt: NOW
    }
    return {
      ...record,
      providerHandleChain: appendAgentSessionProviderHandleLink(record.providerHandleChain, link),
      lease: { ...record.lease, runtimeFence: fence, provenHandleLinkId: link.linkId }
    }
  })
}

function durableFence(): number {
  const record = store.getRecord(SESSION)
  if (!record) {
    throw new Error('session record missing')
  }
  return record.lease.runtimeFence
}

/** The real host, with only the handoff call interposed so a lease can move after admission. */
function protectedTurnHost(
  send: (
    caller: Parameters<StructuredAgentSessionHost['send']>[0],
    params: Parameters<StructuredAgentSessionHost['send']>[1]
  ) => ReturnType<StructuredAgentSessionHost['send']>
): ForgeProtectedSessionTurnHost {
  return {
    send,
    waitForSendSettlement: (...args) => host.waitForSendSettlement(...args),
    history: (...args) => host.history(...args),
    subscribeTurnCompletions: (...args) => host.subscribeTurnCompletions(...args),
    currentWork: (sessionId) => host.currentWork(sessionId),
    sessionRecord: (sessionId) => host.sessionRecord(sessionId)
  }
}

function send(
  port: ForgeProtectedSessionTurnHost,
  fence: number,
  signal = new AbortController().signal
) {
  return sendForgeProtectedSessionTurn({
    host: port,
    sessionId: SESSION,
    callerKey: 'discuss',
    fence,
    prompt: 'question',
    signal
  })
}

describe('protected turn against the real host', () => {
  it('accepts a send whose envelope names a fence the lease never held', async () => {
    await attach()
    const stale = durableFence() + 1
    const body = hostTestMessage('stale fence')
    const params = {
      envelope: envelope('agentSession.send', { body }, { expectedRuntimeFence: stale }),
      body
    }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })

  it('refuses at handoff when the durable lease moved after admission', async () => {
    await attach()
    const fence = durableFence()
    const port = protectedTurnHost(async (caller, params) => {
      await moveFence(fence + 1)
      return host.send(caller, params)
    })

    await expect(send(port, fence)).resolves.toEqual({ kind: 'refused' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.listOperationRows().filter((row) => row.callerKey === 'discuss')).toEqual([])
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history unavailable')
    }
    expect(page.page.submissions).toEqual([])
  })

  it('gets a host-shaped operation id, then quarantines an aborted accepted send', async () => {
    await attach()
    const fence = durableFence()
    const stop = new AbortController()
    const port = protectedTurnHost(host.send)
    const result = send(port, fence, stop.signal)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const rows = () => store.listOperationRows().filter((row) => row.callerKey === 'discuss')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.operationId).toMatch(OPERATION_ID)
    stop.abort()
    await expect(result).resolves.toEqual({ kind: 'unknown' })

    await expect(send(port, fence)).resolves.toEqual({ kind: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
  })
})
