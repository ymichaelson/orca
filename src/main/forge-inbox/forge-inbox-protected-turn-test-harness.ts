import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryResult,
  AgentSessionTurnCompletion,
  AgentSessionWireRefusal
} from '../../shared/agent-session-wire'
import type { ForgeProtectedSessionTurnHost } from './forge-inbox-protected-session-turn'

export const TURN_SESSION = 'protected-session'
export const TURN_ITEM = 'claude:turn-1'
/** The provider's own key for the user row it echoes; the reducer aliases it to the submission key. */
export const PROVIDER_USER_ITEM = agentJournalItemKey({
  provider: 'claude',
  sessionId: TURN_SESSION,
  uuid: 'user-uuid-1'
})
const CURSOR = { epoch: 'epoch-1', sequence: 9 }

export function protectedTurnMessage(
  itemId: string,
  role: 'user' | 'assistant',
  text: string,
  sequence: number,
  turnItemId = TURN_ITEM
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    body: { kind: 'message', role, blocks: [{ type: 'text', text }] },
    sequence,
    observedAt: 1,
    turnScope: { kind: 'turn', turnItemId }
  }
}

/** The journal a real host writes for one send. The reducer aliases the provider's user echo onto
 *  the submission key, so the user row is keyed canonically; the turn names either that submission
 *  key or the provider's key, depending on which row opened it. */
export function protectedTurnJournal(
  messageId: string,
  reply: string,
  state: 'running' | 'completed',
  outcome: AgentJournalTurnOutcome = 'success',
  opener: 'echo' | 'assistant' = 'echo'
): AgentJournalRenderItem[] {
  return [
    protectedTurnMessage(agentJournalSubmissionKey(messageId), 'user', 'question', 1),
    {
      itemId: TURN_ITEM,
      revision: 1,
      sequence: 2,
      observedAt: 1,
      turnScope: { kind: 'thread' },
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        userItemId: opener === 'echo' ? PROVIDER_USER_ITEM : agentJournalSubmissionKey(messageId),
        state,
        ...(state === 'completed' ? { outcome } : {})
      }
    },
    protectedTurnMessage('claude:answer', 'assistant', reply, 3)
  ]
}

export function protectedTurnSubmission(
  messageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: messageId,
    fence: 7,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: dispatchState === 'accepted' ? PROVIDER_USER_ITEM : null,
    submittedAt: 1,
    resolvedAt: 2,
    reason: null
  }
}

export function protectedTurnHarness() {
  const subscribers = new Map<
    string,
    Parameters<ForgeProtectedSessionTurnHost['subscribeTurnCompletions']>[0]
  >()
  const sends: Parameters<ForgeProtectedSessionTurnHost['send']>[] = []
  let items: AgentJournalRenderItem[] = []
  let state: AgentJournalSubmission['dispatchState'] = 'accepted'
  let working = false
  let pendingPrompt = false
  let automaticCompletion = true
  let outcome: AgentJournalTurnOutcome = 'success'
  let completionAwaitingUser = false
  let reply = 'own answer'
  let queued = false
  let fence = 7
  let beforeSend: (() => Promise<void>) | undefined
  let historyRead: (() => Promise<AgentSessionHistoryResult>) | undefined
  let messageId = ''
  let activeTurnId: string | null = null
  let guardRace = false
  let refusal: AgentSessionWireRefusal | undefined

  const publish = (turnId = 'turn-1', verdict = outcome): void => {
    for (const subscriber of subscribers.values()) {
      const completion: AgentSessionTurnCompletion = {
        sessionId: TURN_SESSION,
        turnId,
        outcome: verdict,
        ...(completionAwaitingUser ? { awaitingUser: true as const } : {}),
        completedAt: 2,
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder-1',
          workspaceKind: 'folder'
        }
      }
      subscriber.emit({ type: 'completion', completion })
    }
  }
  const terminal = (verdict = outcome): void => {
    working = false
    activeTurnId = null
    items = items.map((item) =>
      item.body.kind === 'turn' && item.itemId === TURN_ITEM
        ? { ...item, body: { ...item.body, state: 'completed', outcome: verdict } }
        : item
    )
  }
  const port = {
    send: async (...args: Parameters<ForgeProtectedSessionTurnHost['send']>) => {
      await beforeSend?.()
      // A host refusal is admission-time: it never runs the admitted send or its beforeRun.
      if (refusal) {
        return { ok: false as const, refusal }
      }
      if (guardRace) {
        working = true
      }
      args[1].beforeRun?.()
      sends.push(args)
      messageId = args[1].envelope.clientOperationId
      working = true
      activeTurnId = 'turn-1'
      items = protectedTurnJournal(messageId, reply, automaticCompletion ? 'completed' : 'running')
      const answer = queued
        ? {
            clientMessageId: messageId,
            queued: { messageId: 'queued-1', position: 0, state: 'waiting' as const }
          }
        : {
            clientMessageId: messageId,
            submission: protectedTurnSubmission(messageId, state)
          }
      if (automaticCompletion && !queued) {
        terminal()
        publish()
      }
      return { ok: true as const, replayed: false, fence, cursor: CURSOR, value: answer }
    },
    waitForSendSettlement: async () => undefined,
    history: async (): Promise<AgentSessionHistoryResult> =>
      historyRead?.() ?? {
        ok: true,
        page: {
          sessionId: TURN_SESSION,
          epoch: CURSOR.epoch,
          direction: 'tail',
          items,
          removedItemIds: [],
          submissions: messageId ? [protectedTurnSubmission(messageId, state)] : [],
          window: { oldest: null, newest: null, nextCursor: CURSOR },
          liveCursor: CURSOR,
          hasOlder: false,
          hasNewer: false
        }
      },
    currentWork: () => ({
      working: () => working,
      hasActionablePrompt: () => pendingPrompt,
      activeTurnId: () => activeTurnId
    }),
    sessionRecord: () => ({
      lease: {
        runtimeFence: fence,
        unreconciled: false,
        handoffStage: null,
        claimStatus: 'live' as const
      }
    }),
    subscribeTurnCompletions: (
      subscriber: Parameters<ForgeProtectedSessionTurnHost['subscribeTurnCompletions']>[0]
    ) => {
      subscribers.set(subscriber.id, subscriber)
      return () => void subscribers.delete(subscriber.id)
    }
  }
  return {
    port,
    sends,
    publish,
    terminal,
    subscribers,
    get messageId() {
      return messageId
    },
    get items() {
      return items
    },
    set items(value: AgentJournalRenderItem[]) {
      items = value
    },
    set state(value: AgentJournalSubmission['dispatchState']) {
      state = value
    },
    set working(value: boolean) {
      working = value
    },
    set pendingPrompt(value: boolean) {
      pendingPrompt = value
    },
    set automaticCompletion(value: boolean) {
      automaticCompletion = value
    },
    set outcome(value: AgentJournalTurnOutcome) {
      outcome = value
    },
    set completionAwaitingUser(value: boolean) {
      completionAwaitingUser = value
    },
    set reply(value: string) {
      reply = value
    },
    set queued(value: boolean) {
      queued = value
    },
    get fence() {
      return fence
    },
    set fence(value: number) {
      fence = value
    },
    set beforeSend(value: (() => Promise<void>) | undefined) {
      beforeSend = value
    },
    set historyRead(value: (() => Promise<AgentSessionHistoryResult>) | undefined) {
      historyRead = value
    },
    set guardRace(value: boolean) {
      guardRace = value
    },
    set refusal(value: AgentSessionWireRefusal | undefined) {
      refusal = value
    }
  }
}

export async function flushProtectedTurn(): Promise<void> {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve()
  }
}
