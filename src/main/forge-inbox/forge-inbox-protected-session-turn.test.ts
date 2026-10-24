import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import {
  refuse,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryResult
} from '../../shared/agent-session-wire'
import {
  FORGE_PROTECTED_TURN_DEADLINE_MS,
  sendForgeProtectedSessionTurn
} from './forge-inbox-protected-session-turn'
import {
  FORGE_PROTECTED_REPLY_MAX_BYTES,
  readForgeProtectedTurnProof
} from './forge-inbox-protected-turn-proof'
import {
  flushProtectedTurn,
  protectedTurnHarness,
  protectedTurnJournal,
  protectedTurnMessage,
  protectedTurnSubmission,
  TURN_SESSION
} from './forge-inbox-protected-turn-test-harness'

function send(
  host: ReturnType<typeof protectedTurnHarness>,
  signal = new AbortController().signal
) {
  return sendForgeProtectedSessionTurn({
    host: host.port,
    sessionId: TURN_SESSION,
    callerKey: 'discuss',
    fence: host.fence,
    prompt: 'question',
    signal
  })
}

afterEach(() => vi.useRealTimers())

describe('protected same-session turn proof', () => {
  it('accepts an early exact successful completion', async () => {
    const host = protectedTurnHarness()
    await expect(send(host)).resolves.toEqual({ kind: 'reply', text: 'own answer' })
    expect(host.subscribers.size).toBe(0)
  })

  it('ignores an unrelated completion until its own turn completes', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    let settled = false
    const result = send(host).then((value) => {
      settled = true
      return value
    })
    await flushProtectedTurn()
    host.publish('stale-turn')
    await flushProtectedTurn()
    expect(settled).toBe(false)
    host.terminal()
    host.publish()
    await expect(result).resolves.toEqual({ kind: 'reply', text: 'own answer' })
  })

  it('does not accept failed completion text as a successful reply', async () => {
    const host = protectedTurnHarness()
    host.outcome = 'failure'
    await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
  })

  it('keeps a successful journal turn unknown when its completion failed', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    host.terminal('success')
    host.publish('turn-1', 'failure')
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('keeps a failed journal turn unknown when its completion succeeded', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    host.terminal('failure')
    host.publish('turn-1', 'success')
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('keeps a successful turn unknown when its completion awaits the user', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    host.completionAwaitingUser = true
    const result = send(host)
    await flushProtectedTurn()
    host.terminal('success')
    host.publish('turn-1', 'success')
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('reads its own turn, not text after another user or from a subagent', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    host.items = [
      ...host.items,
      { ...protectedTurnMessage('child', 'assistant', 'child answer', 4), agentId: 'child-1' },
      protectedTurnMessage('another-user', 'user', 'other question', 5, 'other-turn'),
      protectedTurnMessage('another-answer', 'assistant', 'wrong answer', 6, 'other-turn')
    ]
    host.terminal()
    host.publish()
    await expect(result).resolves.toEqual({ kind: 'reply', text: 'own answer' })
  })

  it.each(['pending', 'unknown'] as const)(
    'keeps %s dispatch unknown, never refused',
    async (state) => {
      const host = protectedTurnHarness()
      host.state = state
      await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
    }
  )

  it('keeps an unexpected queued send unknown, never a reply', async () => {
    const host = protectedTurnHarness()
    host.queued = true
    await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
    expect(host.subscribers.size).toBe(0)
  })

  it('does not claim a turn whose opener is another user', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const stop = new AbortController()
    const result = send(host, stop.signal)
    await flushProtectedTurn()
    host.items = host.items.map((item) =>
      item.body.kind === 'turn'
        ? { ...item, body: { ...item.body, userItemId: 'other-user' } }
        : item
    )
    host.terminal()
    host.publish()
    await flushProtectedTurn()
    stop.abort()
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('rejects shortened same-turn output', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    host.items = host.items.map((item) =>
      item.body.kind === 'message' && item.body.role === 'assistant'
        ? { ...item, shortened: true }
        : item
    )
    host.terminal()
    host.publish()
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('rejects an oversized same-turn output', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    host.reply = 'x'.repeat(FORGE_PROTECTED_REPLY_MAX_BYTES + 1)
    const result = send(host)
    await flushProtectedTurn()
    host.terminal()
    host.publish()
    await expect(result).resolves.toEqual({ kind: 'unknown' })
  })

  it('holds the session lane across completion and readback for different callers', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const first = send(host)
    await flushProtectedTurn()
    const secondStop = new AbortController()
    const second = sendForgeProtectedSessionTurn({
      host: host.port,
      sessionId: TURN_SESSION,
      callerKey: 'patch-producer',
      fence: 7,
      prompt: 'patch',
      signal: secondStop.signal
    })
    await flushProtectedTurn()
    expect(host.sends).toHaveLength(1)
    secondStop.abort()
    host.terminal()
    host.publish()
    await expect(first).resolves.toEqual({ kind: 'reply', text: 'own answer' })
    await expect(second).resolves.toEqual({ kind: 'refused' })
    expect(host.sends).toHaveLength(1)
  })

  it('refuses active work and the synchronous pre-admission idle race', async () => {
    const active = protectedTurnHarness()
    active.working = true
    await expect(send(active)).resolves.toEqual({ kind: 'refused' })
    expect(active.sends).toHaveLength(0)
    const raced = protectedTurnHarness()
    raced.guardRace = true
    await expect(send(raced)).resolves.toEqual({ kind: 'refused' })
    expect(raced.sends).toHaveLength(0)
  })

  it('refuses a fence the record no longer holds', async () => {
    const host = protectedTurnHarness()
    const stale = sendForgeProtectedSessionTurn({
      host: host.port,
      sessionId: TURN_SESSION,
      callerKey: 'discuss',
      fence: 6,
      prompt: 'question',
      signal: new AbortController().signal
    })
    await expect(stale).resolves.toEqual({ kind: 'refused' })
    expect(host.sends).toHaveLength(0)
  })

  it('rechecks the durable fence synchronously at admission', async () => {
    const host = protectedTurnHarness()
    // The record moves after the idle read, before the host runs the send.
    host.beforeSend = async () => {
      host.fence = 8
    }
    await expect(send(host)).resolves.toEqual({ kind: 'refused' })
    expect(host.sends).toHaveLength(0)
  })

  it('matches an assistant-first turn that names the submission key directly', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    host.items = protectedTurnJournal(
      host.messageId,
      'own answer',
      'running',
      'success',
      'assistant'
    )
    host.terminal()
    host.publish()
    await expect(result).resolves.toEqual({ kind: 'reply', text: 'own answer' })
  })

  it('keeps an unknown host outcome quarantined instead of clearing it', async () => {
    const host = protectedTurnHarness()
    host.refusal = refuse(
      'agent_session_operation_unknown',
      { reason: 'outcomeUnknown' },
      'unknown'
    )
    await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
    expect(host.sends).toHaveLength(0)
    // The refused call named no delivery; no later idle state may release the session.
    host.refusal = undefined
    await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
    expect(host.sends).toHaveLength(0)
  })

  it('clears quarantine after a proved pre-dispatch refusal', async () => {
    const host = protectedTurnHarness()
    host.refusal = refuse(
      'agent_session_operation_invalid',
      { reason: 'operationIdInvalid' },
      'invalid'
    )
    await expect(send(host)).resolves.toEqual({ kind: 'refused' })
    host.refusal = undefined
    await expect(send(host)).resolves.toEqual({ kind: 'reply', text: 'own answer' })
    expect(host.sends).toHaveLength(1)
  })

  it('bounds the wait at the deadline and releases its subscription', async () => {
    vi.useFakeTimers()
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const result = send(host)
    await flushProtectedTurn()
    expect(host.sends).toHaveLength(1)
    expect(host.subscribers.size).toBe(1)
    vi.advanceTimersByTime(FORGE_PROTECTED_TURN_DEADLINE_MS)
    await expect(result).resolves.toEqual({ kind: 'unknown' })
    await flushProtectedTurn()
    expect(host.subscribers.size).toBe(0)
  })

  it('quarantines an aborted active turn until its terminal proof arrives', async () => {
    const host = protectedTurnHarness()
    host.automaticCompletion = false
    const stop = new AbortController()
    const first = send(host, stop.signal)
    await flushProtectedTurn()
    stop.abort()
    await expect(first).resolves.toEqual({ kind: 'unknown' })
    // An unrelated edge is not the ORIGINAL request's terminal proof.
    host.publish('stale-turn')
    await expect(send(host)).resolves.toEqual({ kind: 'unknown' })
    expect(host.sends).toHaveLength(1)
    expect(host.subscribers.size).toBe(0)
    host.terminal()
    host.automaticCompletion = true
    await expect(send(host)).resolves.toEqual({ kind: 'reply', text: 'own answer' })
  })
})

describe('protected turn proof snapshot coherence', () => {
  const messageId = 'coherent-send'
  const epoch = 'epoch-1'
  const earlier = protectedTurnJournal(messageId, 'second', 'completed', 'success', 'assistant')
  const newer = protectedTurnMessage('claude:answer-newer', 'assistant', 'newer', 5)

  function page(
    items: AgentJournalRenderItem[],
    liveSequence: number,
    hasOlder: boolean,
    nextSequence: number,
    submissions: AgentJournalSubmission[] = []
  ): AgentSessionHistoryResult {
    const page: AgentSessionHistoryPage = {
      sessionId: TURN_SESSION,
      epoch,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions,
      window: { oldest: null, newest: null, nextCursor: { epoch, sequence: nextSequence } },
      liveCursor: { epoch, sequence: liveSequence },
      hasOlder,
      hasNewer: false
    }
    return { ok: true, page }
  }

  function proofWith(liveBefore: number, liveTail: number) {
    return readForgeProtectedTurnProof(
      {
        history: async (request) =>
          request.direction === 'tail'
            ? page([newer], liveTail, true, 4)
            : page(earlier, liveBefore, false, 0)
      },
      TURN_SESSION,
      messageId
    )
  }

  it('rejects an old tail paired with a newer terminal page', async () => {
    await expect(proofWith(11, 10)).resolves.toBeNull()
  })

  it('reads a coherent snapshot, including rows newer than the turn record', async () => {
    await expect(proofWith(10, 10)).resolves.toEqual({
      turnId: 'turn-1',
      terminal: true,
      outcome: 'success',
      text: 'second\nnewer'
    })
  })

  function rootTurn(
    itemId: string,
    turnId: string,
    userItemId = agentJournalSubmissionKey(messageId),
    sequence = 1
  ): AgentJournalRenderItem {
    return {
      itemId,
      revision: 1,
      sequence,
      observedAt: 1,
      turnScope: { kind: 'thread' },
      body: { kind: 'turn', turnId, userItemId, state: 'completed', outcome: 'success' }
    }
  }

  it('rejects a second matching turn on an older page', async () => {
    const submission = {
      ...protectedTurnSubmission(messageId, 'accepted'),
      submittedSequence: 1
    }
    const result = await readForgeProtectedTurnProof(
      {
        history: async (request) =>
          request.direction === 'tail'
            ? page(
                [
                  rootTurn('claude:turn-tail', 'turn-tail', agentJournalSubmissionKey(messageId), 3)
                ],
                10,
                true,
                4,
                [submission]
              )
            : page(
                [
                  rootTurn(
                    'claude:turn-older',
                    'turn-older',
                    agentJournalSubmissionKey(messageId),
                    2
                  )
                ],
                10,
                false,
                0
              )
      },
      TURN_SESSION,
      messageId
    )
    await expect(result).toBeNull()
  })

  function cappedJournal(submission: AgentJournalSubmission): AgentSessionHistoryResult[] {
    return [
      snapshot(
        [rootTurn('claude:turn-tail', 'turn-tail', agentJournalSubmissionKey(messageId), 60)],
        {
          live: { epoch, sequence: 100 },
          hasOlder: true,
          next: { epoch, sequence: 40 },
          submissions: [submission]
        }
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        snapshot([], {
          live: { epoch, sequence: 100 },
          hasOlder: true,
          next: { epoch, sequence: 30 - index * 5 }
        })
      )
    ]
  }

  it('completes the proof window at the submission row instead of the journal head', async () => {
    const submission = {
      ...protectedTurnSubmission(messageId, 'accepted'),
      submittedSequence: 50
    }
    await expect(
      readForgeProtectedTurnProof(pages(cappedJournal(submission)), TURN_SESSION, messageId)
    ).resolves.toEqual({ turnId: 'turn-tail', terminal: true, outcome: 'success', text: null })
  })

  it('keeps the page cap when an older host omits submittedSequence', async () => {
    const submission = protectedTurnSubmission(messageId, 'accepted')
    await expect(
      readForgeProtectedTurnProof(pages(cappedJournal(submission)), TURN_SESSION, messageId)
    ).resolves.toBeNull()
  })

  function snapshot(
    items: AgentJournalRenderItem[],
    options: {
      epoch?: string
      live?: { epoch: string; sequence: number } | null
      hasOlder?: boolean
      next?: { epoch: string; sequence: number }
      submissions?: AgentJournalSubmission[]
    } = {}
  ): AgentSessionHistoryResult {
    const pageEpoch = options.epoch ?? epoch
    const live = options.live === undefined ? { epoch: pageEpoch, sequence: 10 } : options.live
    const snapshotPage: AgentSessionHistoryPage = {
      sessionId: TURN_SESSION,
      epoch: pageEpoch,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: options.submissions ?? [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: options.next ?? { epoch: pageEpoch, sequence: 0 }
      },
      ...(live === null ? {} : { liveCursor: live }),
      hasOlder: options.hasOlder ?? false,
      hasNewer: false
    }
    return { ok: true, page: snapshotPage }
  }

  function pages(result: AgentSessionHistoryResult[]) {
    let call = 0
    return { history: async () => result[call++] }
  }

  it('rejects two matching turns on the same page', async () => {
    await expect(
      readForgeProtectedTurnProof(
        pages([
          snapshot([rootTurn('claude:turn-a', 'turn-a'), rootTurn('claude:turn-b', 'turn-b')])
        ]),
        TURN_SESSION,
        messageId
      )
    ).resolves.toBeNull()
  })

  it('rejects a page with no live cursor', async () => {
    await expect(
      readForgeProtectedTurnProof(
        pages([snapshot([rootTurn('claude:turn-a', 'turn-a')], { live: null })]),
        TURN_SESSION,
        messageId
      )
    ).resolves.toBeNull()
  })

  it('rejects pages from different journal epochs with equal sequences', async () => {
    await expect(
      readForgeProtectedTurnProof(
        pages([
          snapshot([], {
            live: { epoch, sequence: 10 },
            hasOlder: true,
            next: { epoch, sequence: 4 }
          }),
          snapshot([rootTurn('claude:turn-epoch', 'turn-epoch')], {
            epoch: 'epoch-2',
            live: { epoch: 'epoch-2', sequence: 10 }
          })
        ]),
        TURN_SESSION,
        messageId
      )
    ).resolves.toBeNull()
  })

  it('rejects pagination whose cursor does not move older', async () => {
    await expect(
      readForgeProtectedTurnProof(
        pages([
          snapshot([], { hasOlder: true, next: { epoch, sequence: 8 } }),
          snapshot([], { hasOlder: true, next: { epoch, sequence: 9 } }),
          snapshot([rootTurn('claude:turn-cursor', 'turn-cursor')])
        ]),
        TURN_SESSION,
        messageId
      )
    ).resolves.toBeNull()
  })

  it('rejects a proof window cut off by the page cap', async () => {
    await expect(
      readForgeProtectedTurnProof(
        pages(
          Array.from({ length: 5 }, (_, index) =>
            snapshot(index === 0 ? [rootTurn('claude:turn-cap', 'turn-cap')] : [], {
              hasOlder: true,
              next: { epoch, sequence: 8 - index }
            })
          )
        ),
        TURN_SESSION,
        messageId
      )
    ).resolves.toBeNull()
  })

  it('rejects a page that exceeds the scanned item cap', async () => {
    const items = Array.from({ length: 401 }, (_, index) =>
      index === 0
        ? rootTurn('claude:turn-item-cap', 'turn-item-cap')
        : rootTurn(`claude:turn-${index}`, `turn-${index}`, 'other-user')
    )
    await expect(
      readForgeProtectedTurnProof(pages([snapshot(items)]), TURN_SESSION, messageId)
    ).resolves.toBeNull()
  })

  it('rejects a page that exceeds the scanned byte cap', async () => {
    const huge = protectedTurnMessage('claude:huge', 'assistant', 'x'.repeat(1_100_000), 1)
    const turn = rootTurn(
      'claude:turn-bytes',
      'turn-bytes',
      agentJournalSubmissionKey(messageId),
      2
    )
    await expect(
      readForgeProtectedTurnProof(pages([snapshot([huge, turn])]), TURN_SESSION, messageId)
    ).resolves.toBeNull()
  })
})
