import { randomUUID } from 'node:crypto'
import type { AgentSessionTurnCompletion } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'

/** What a protected session turn needs of the host: send, settle, read back. No creation. */
export type ForgeProtectedSessionTurnHost = Pick<
  StructuredAgentSessionHost,
  'send' | 'waitForSendSettlement' | 'history' | 'subscribeTurnCompletions'
>

/** Shell history the turn reads back; tools are off, so one turn writes very few rows. */
const REPLY_HISTORY_LIMIT = 200

/** `refused` means no turn exists; `unknown` means a turn was handed over but not proven answered. */
export type ForgeProtectedTurnOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'refused' }
  | { kind: 'unknown' }

/**
 * Sends one host-authored turn into a session that already exists and reads the assistant's answer.
 * The session is addressed by id and fence only: nothing here can found or replace it.
 */
export async function sendForgeProtectedSessionTurn(input: {
  host: ForgeProtectedSessionTurnHost
  callerKey: string
  sessionId: string
  fence: number
  prompt: string
  signal: AbortSignal
}): Promise<ForgeProtectedTurnOutcome> {
  const { host, sessionId, signal } = input
  if (signal.aborted) {
    return { kind: 'refused' }
  }
  let settle: ((completion: AgentSessionTurnCompletion | null) => void) | undefined
  const completed = new Promise<AgentSessionTurnCompletion | null>((resolve) => {
    settle = resolve
  })
  // Subscribed before the send: a turn this short can settle before the send call returns.
  const unsubscribe = host.subscribeTurnCompletions({
    id: randomUUID(),
    emit: (event) => {
      if (event.type === 'completion' && event.completion.sessionId === sessionId) {
        settle?.(event.completion)
      }
    }
  })
  try {
    const sent = await sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId,
      callerKey: input.callerKey,
      turn: {
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: input.prompt }]
        },
        operationId: randomUUID(),
        expectedRuntimeFence: input.fence,
        delivery: 'now'
      },
      signal
    })
    // Accepted is the hand-off, not the answer; anything else proves no turn to read.
    if (sent.kind !== 'sent' || sent.submission?.dispatchState !== 'accepted') {
      return { kind: 'refused' }
    }
    const completion = await raceAbort(completed, signal)
    if (!completion) {
      return { kind: 'unknown' }
    }
    const text = await readAssistantReply(host, sessionId)
    return text === null ? { kind: 'unknown' } : { kind: 'reply', text }
  } finally {
    settle?.(null)
    unsubscribe()
  }
}

function raceAbort<T>(pending: Promise<T | null>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

/** The assistant's text for the turn the prompt opened, or null when it said nothing readable. */
async function readAssistantReply(
  host: ForgeProtectedSessionTurnHost,
  sessionId: string
): Promise<string | null> {
  const result = await host.history(
    { sessionId, direction: 'tail', limit: REPLY_HISTORY_LIMIT },
    'own-agent'
  )
  const items = result.page.items
  let lastUser = -1
  for (let index = 0; index < items.length; index += 1) {
    const body = items[index].body
    if (body.kind === 'message' && body.role === 'user') {
      lastUser = index
    }
  }
  if (lastUser === -1) {
    return null
  }
  const text: string[] = []
  for (const item of items.slice(lastUser + 1)) {
    if (item.body.kind !== 'message' || item.body.role !== 'assistant') {
      continue
    }
    for (const block of item.body.blocks) {
      if (block.type === 'text') {
        text.push(block.text)
      }
    }
  }
  const reply = text.join('\n')
  return reply.trim() === '' ? null : reply
}
