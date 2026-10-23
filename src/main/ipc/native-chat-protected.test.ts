// A protected analysis is untrusted MR text. The legacy native-chat reader/watcher is not one of
// the surfaces that renders it inertly, so both its desktop IPC and paired RPC paths must refuse
// it rather than hand the raw transcript to whichever client asked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../runtime/rpc/core'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  installOwnership,
  PROVIDER_SESSION
} from '../ai-vault/structured-session-ownership.test-support'

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    }
  }
}))

const { readTail, subscribe } = vi.hoisted(() => ({
  readTail: vi.fn(async () => ({ messages: [], hasMore: false, beforeOffset: 0 })),
  subscribe: vi.fn(async () => ({ unsubscribe: () => {}, watching: true }))
}))

vi.mock('../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: readTail,
  subscribeNativeChatTranscript: subscribe
}))

import { registerNativeChatHandlers } from './native-chat'
import { NATIVE_CHAT_METHODS } from '../runtime/rpc/methods/native-chat'

const SESSION = PROVIDER_SESSION
const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }

function readSessionHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find(
    (candidate) => candidate.name === 'nativeChat.readSession'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered handler takes these params; this test drives the method by name.
  return method!.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

function subscribeHandler(): (
  params: unknown,
  ctx: RpcContext,
  emit: (value: unknown) => void
) => Promise<void> {
  const method = NATIVE_CHAT_METHODS.find((candidate) => candidate.name === 'nativeChat.subscribe')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered handler takes these params; this test drives the method by name.
  return method!.handler as (
    params: unknown,
    ctx: RpcContext,
    emit: (value: unknown) => void
  ) => Promise<void>
}

function context(): RpcContext {
  const runtime = {
    getAgentProviderSessionRows: () => [],
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only the hook rows and the subscription registry.
  return { runtime: runtime as unknown as RpcContext['runtime'], clientKind: 'runtime' }
}

function installProtected(): void {
  installOwnership({ protected: true, handle: claudeProviderHandle(SESSION, null) })
}

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  readTail.mockClear()
  subscribe.mockClear()
  sender.send.mockClear()
})

afterEach(() => setStructuredAgentSessionHost(null))

describe('a protected analysis read through legacy native chat', () => {
  it('refuses the paired read without touching the transcript', async () => {
    installProtected()
    registerNativeChatHandlers()

    const result = await readSessionHandler()({ agent: 'claude', sessionId: SESSION }, context())
    const desktop = await handlers.get('nativeChat:readSession')!(
      {},
      {
        agent: 'claude',
        sessionId: SESSION
      }
    )

    for (const answer of [result, desktop]) {
      expect(answer).toEqual({
        error: expect.stringContaining('Inbox')
      })
    }
    expect(readTail).not.toHaveBeenCalled()
  })

  it('refuses the paired watch and the desktop watch without installing one', async () => {
    installProtected()
    registerNativeChatHandlers()
    const frames: unknown[] = []

    await subscribeHandler()({ agent: 'claude', sessionId: SESSION }, context(), (frame) =>
      frames.push(frame)
    )
    listeners.get('nativeChat:subscribe')!(
      { sender },
      { subscriptionId: 'sub-1', agent: 'claude', sessionId: SESSION }
    )

    expect(frames).toEqual([
      { type: 'snapshot', messages: [], hasMore: false, error: expect.stringContaining('Inbox') }
    ])
    expect(sender.send).toHaveBeenCalledWith(
      'nativeChat:appended',
      expect.objectContaining({ subscriptionId: 'sub-1' })
    )
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('leaves an ordinary chat reading and watching', async () => {
    installOwnership({ handle: claudeProviderHandle(SESSION, null) })
    registerNativeChatHandlers()

    await readSessionHandler()({ agent: 'claude', sessionId: SESSION }, context())
    await handlers.get('nativeChat:readSession')!({}, { agent: 'claude', sessionId: SESSION })

    expect(readTail).toHaveBeenCalledTimes(2)
  })
})
