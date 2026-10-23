// A protected analysis exists because its content cannot be shown safely by every client: Forge
// transcripts carry untrusted MR text that only an inert renderer may draw. So the host must not
// hand one over — transcript, item, send, live stream or adoption — to a client that has not said
// it renders that way. Cleanup must keep working: refusing a close strands a live child.

import '../unused-default-rpc-methods.test-fixture'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY } from '../../../../shared/agent-session-protected-output-capability'
import { PROTECTED_ANALYSIS_MARKER } from '../../../../shared/agent-session-protected-claude-launch.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  hostStub,
  openStream,
  sendParams,
  SESSION,
  STATUS_SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import type { RpcResponse } from '../core'

const DOMAIN_UNAVAILABLE = {
  message: expect.stringContaining('structured_agent_session_unsupported')
}

/** The released structured client: it reads ordinary chats, and says nothing about protected ones. */
const INCAPABLE = STRUCTURED_CLIENT
const CAPABLE = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_PROTECTED_OUTPUT_CLIENT_CAPABILITY
  ]
}

function protectedRecord(sessionId = SESSION): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    schemaVersion: 3,
    protectedAnalysis: PROTECTED_ANALYSIS_MARKER
  }
}

function installHost(
  records: Record<string, AgentSessionRecord>,
  overrides: Record<string, unknown> = {}
): void {
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        logger: recordingStructuredAgentSessionLogger().logger,
        store: { getRecord: (sessionId: string) => records[sessionId] ?? null },
        adapter: {}
      },
      ...overrides
    })
  )
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function completionSessionIds(replies: readonly RpcResponse[]): unknown[] {
  return replies.map((reply) => field(field(field(reply, 'result'), 'completion'), 'sessionId'))
}

beforeEach(() => {
  clearStructuredHostStub()
})

describe('protected analysis is not readable by a client that cannot render it inertly', () => {
  it('refuses history without opening the journal', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call(
      'agentSession.history',
      { sessionId: SESSION, direction: 'tail' },
      INCAPABLE
    )
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.history).not.toHaveBeenCalled()
  })

  it('answers history for a client that does render it inertly', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call(
      'agentSession.history',
      { sessionId: SESSION, direction: 'tail' },
      CAPABLE
    )
    expect(reply).toMatchObject({ ok: true })
    expect(hostCalls.history).toHaveBeenCalledOnce()
  })

  it('refuses a send before any byte reaches the host', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call('agentSession.send', sendParams(), INCAPABLE)
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.send).not.toHaveBeenCalled()
  })

  it('refuses one item whole and never reads the snapshot', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call(
      'agentSession.item',
      { sessionId: SESSION, itemId: 'user-1' },
      INCAPABLE
    )
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.journalSnapshot).not.toHaveBeenCalled()
  })

  it('refuses the options read that a live provider would answer', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call('agentSession.options', { sessionId: SESSION }, INCAPABLE)
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.readOptions).not.toHaveBeenCalled()
  })

  it('refuses a transcript subscription', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call('agentSession.subscribe', { sessionId: SESSION }, INCAPABLE)
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.subscribe).not.toHaveBeenCalled()
  })

  it('refuses to adopt a protected record into an ordinary chat and publishes no tab', async () => {
    installHost({ [SESSION]: protectedRecord() })
    const reply = await call('agentSession.ensure', attachParams(), INCAPABLE)
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it('refuses to reveal a protected chat, so no tab is published for it', async () => {
    // Reveal answers a refusal as a result, not a failed call: the chat stays shut either way.
    const publish = vi.fn()
    installHost({ [SESSION]: protectedRecord() }, { publishStructuredAgentSessionTab: publish })
    const reply = await call('agentSession.reveal', { sessionId: SESSION }, INCAPABLE)
    expect(reply).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
    })
    expect(hostCalls.revealSession).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('refuses to continue an interrupted protected turn', async () => {
    const continueInterrupted = vi.fn(async () => ({ results: [] }))
    installHost(
      { [SESSION]: protectedRecord() },
      { restartResume: { continueInterrupted, continueAfterRestart: vi.fn(), list: vi.fn() } }
    )
    const reply = await call(
      'agentSession.continueInterrupted',
      { sessionId: SESSION, turnItemId: 'turn-1' },
      INCAPABLE
    )
    expect(reply).toMatchObject({ ok: false, error: DOMAIN_UNAVAILABLE })
    expect(continueInterrupted).not.toHaveBeenCalled()
  })
})

describe('protected analysis stays out of the host-wide streams', () => {
  it('omits a protected row from the status snapshot, and keeps it for a capable client', async () => {
    installHost({ [STATUS_SESSION]: protectedRecord(STATUS_SESSION) })
    const refused = await call('agentSession.subscribeStatus', null, INCAPABLE)
    expect(refused).toMatchObject({ ok: true, result: { type: 'snapshot', sessions: [] } })

    installHost({ [STATUS_SESSION]: protectedRecord(STATUS_SESSION) })
    const admitted = await call('agentSession.subscribeStatus', null, CAPABLE)
    expect(admitted).toMatchObject({
      ok: true,
      result: { type: 'snapshot', sessions: [{ sessionId: STATUS_SESSION }] }
    })
  })

  it('drops turn completions and prompts for a protected session', async () => {
    const emitOnSubscribe =
      (events: readonly unknown[]) => (subscriber: { emit: (event: unknown) => void }) => {
        for (const event of events) {
          subscriber.emit(event)
        }
        return () => {}
      }
    const events = [
      {
        type: 'completion',
        completion: { sessionId: SESSION, turnId: 'turn-1', outcome: 'success' }
      },
      {
        type: 'completion',
        completion: { sessionId: 'ordinary', turnId: 'turn-2', outcome: 'success' }
      }
    ]
    installHost(
      { [SESSION]: protectedRecord() },
      {
        sessionAgent: (sessionId: string) => (sessionId === 'ordinary' ? 'codex' : null),
        subscribeTurnCompletions: emitOnSubscribe(events)
      }
    )
    const replies = await openStream(
      'agentSession.subscribeTurnCompletions',
      {},
      { ...INCAPABLE, clientId: 'device-1' }
    )
    expect(completionSessionIds(replies)).toEqual(['ordinary'])

    installHost(
      { [SESSION]: protectedRecord() },
      {
        sessionAgent: (sessionId: string) => (sessionId === 'ordinary' ? 'codex' : null),
        subscribeTurnCompletions: emitOnSubscribe(events)
      }
    )
    const admitted = await openStream(
      'agentSession.subscribeTurnCompletions',
      {},
      {
        ...CAPABLE,
        clientId: 'device-2'
      }
    )
    expect(completionSessionIds(admitted)).toEqual([SESSION, 'ordinary'])
  })

  it('never offers a protected session for ordinary restart-resume', async () => {
    const list = vi.fn(async () => [
      { sessionId: SESSION, agent: 'codex', workspaceId: 'workspace-1' }
    ])
    installHost(
      { [SESSION]: protectedRecord() },
      {
        knownAgentIds: () => ['codex'],
        restartResume: { list, listFailures: vi.fn(async () => []) }
      }
    )
    const reply = await call('agentSession.restartResumable', {}, INCAPABLE)
    expect(reply).toMatchObject({ ok: true, result: { sessions: [] } })

    installHost(
      { [SESSION]: protectedRecord() },
      {
        knownAgentIds: () => ['codex'],
        restartResume: { list, listFailures: vi.fn(async () => []) }
      }
    )
    const admitted = await call('agentSession.restartResumable', {}, CAPABLE)
    expect(admitted).toMatchObject({
      ok: true,
      result: { sessions: [{ sessionId: SESSION }] }
    })
  })
})

describe('cleanup of a protected session is never gated', () => {
  it('still closes and cancels for a client without the output capability', async () => {
    installHost({ [SESSION]: protectedRecord() })
    expect(await call('agentSession.close', { sessionId: SESSION }, INCAPABLE)).toMatchObject({
      ok: true
    })
    expect(await call('agentSession.cancel', { envelope: envelope() }, INCAPABLE)).toMatchObject({
      ok: true
    })
    expect(hostCalls.close).toHaveBeenCalledOnce()
    expect(hostCalls.cancel).toHaveBeenCalledOnce()
  })
})
