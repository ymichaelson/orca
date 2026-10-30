import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionTurnCompletionEvent
} from '../../shared/agent-session-wire'
import { refuseUnclassified } from '../../shared/agent-session-wire-refusals'
import type { ProjectEventRunCancelHost } from './forge-inbox-project-event-run-cancel'
import {
  protectedTurnMessage,
  protectedTurnSubmission
} from './forge-inbox-protected-turn-test-harness'

const CURSOR = { epoch: 'epoch-1', sequence: 9 }
export const CANCEL_SESSION = 'structured-claude-1'

export type FakeTurn = {
  messageId: string
  turnId: string
  state: 'running' | 'completed'
  outcome?: AgentJournalTurnOutcome
}

export type FakeCancelCall = {
  callerKey: string
  sessionId: string
  operationId: string
  fence: number | null
  payloadFingerprint: string
  turnId: string | undefined
}

export type FakeCancelMode = 'accept' | 'refuse' | 'throw' | 'hang' | 'decline'

function turnJournal(turns: readonly FakeTurn[]): AgentJournalRenderItem[] {
  return turns.flatMap((turn, index) => {
    const turnItemId = `claude:${turn.turnId}`
    const sequence = index * 3 + 1
    return [
      protectedTurnMessage(
        agentJournalSubmissionKey(turn.messageId),
        'user',
        'question',
        sequence,
        turnItemId
      ),
      {
        itemId: turnItemId,
        revision: 1,
        sequence: sequence + 1,
        observedAt: 1,
        turnScope: { kind: 'thread' as const },
        body: {
          kind: 'turn' as const,
          turnId: turn.turnId,
          userItemId: agentJournalSubmissionKey(turn.messageId),
          state: turn.state,
          ...(turn.state === 'completed' ? { outcome: turn.outcome ?? 'success' } : {})
        }
      },
      protectedTurnMessage(
        `claude:answer-${turn.turnId}`,
        'assistant',
        'report',
        sequence + 2,
        turnItemId
      )
    ]
  })
}

/** A structured host double: a journal that proves turns, a session lease, and a Stop that records its call. */
export function createFakeCancelHost(options: { fence?: number } = {}) {
  const turns: FakeTurn[] = []
  const subscribers = new Map<
    string,
    { id: string; emit: (event: AgentSessionTurnCompletionEvent) => void }
  >()
  const statusSubscribers = new Map<
    string,
    { id: string; emit: (event: AgentSessionStatusEvent) => void }
  >()
  const calls: FakeCancelCall[] = []
  const hung: (() => void)[] = []
  let historyReads = 0
  let historyGate: Promise<void> | null = null
  const control: {
    fence: number
    holdsSession: boolean
    mode: FakeCancelMode
    sessionId: string
    /** The turn ends, and its completion is published, before the Stop's receipt returns. */
    completeOnCancel: AgentJournalTurnOutcome | null
    /** Runs inside the Stop, once its call is recorded and before it answers. */
    onCancel: (() => void) | null
  } = {
    fence: options.fence ?? 7,
    holdsSession: true,
    mode: 'accept',
    sessionId: CANCEL_SESSION,
    completeOnCancel: null,
    onCancel: null
  }
  function complete(messageId: string, outcome: AgentJournalTurnOutcome): void {
    const turn = turns.find((entry) => entry.messageId === messageId)
    if (!turn) {
      throw new Error('no such turn')
    }
    turn.state = 'completed'
    turn.outcome = outcome
    for (const subscriber of subscribers.values()) {
      subscriber.emit({
        type: 'completion',
        completion: {
          sessionId: control.sessionId,
          turnId: turn.turnId,
          outcome,
          completedAt: 2,
          scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'folder-1',
            workspaceKind: 'folder'
          }
        }
      })
    }
  }
  const host: ProjectEventRunCancelHost = {
    history: async (params) => {
      historyReads += 1
      await historyGate
      return {
        ok: true,
        page: {
          sessionId: params.sessionId,
          epoch: CURSOR.epoch,
          direction: 'tail',
          items: turnJournal(turns),
          removedItemIds: [],
          submissions: turns.map((turn) => ({
            ...protectedTurnSubmission(turn.messageId, 'accepted'),
            providerItemId: null
          })),
          window: { oldest: null, newest: null, nextCursor: CURSOR },
          liveCursor: CURSOR,
          hasOlder: false,
          hasNewer: false
        }
      }
    },
    subscribeStatus: (subscriber) => {
      statusSubscribers.set(subscriber.id, subscriber)
      return () => void statusSubscribers.delete(subscriber.id)
    },
    sessionRecord: () =>
      control.holdsSession
        ? {
            lease: {
              runtimeFence: control.fence,
              unreconciled: false,
              handoffStage: null,
              claimStatus: 'live' as const
            }
          }
        : null,
    cancel: async (caller, params) => {
      calls.push({
        callerKey: caller.callerKey,
        sessionId: params.envelope.sessionId,
        operationId: params.envelope.clientOperationId,
        fence: params.envelope.expectedRuntimeFence,
        payloadFingerprint: params.envelope.payloadFingerprint,
        turnId: params.turnId
      })
      control.onCancel?.()
      if (control.mode === 'throw') {
        throw new Error('host unreachable')
      }
      if (control.mode === 'refuse') {
        return { ok: false, refusal: refuseUnclassified('agent_session_conflict', 'stale fence') }
      }
      const answer = {
        ok: true as const,
        replayed: false,
        fence: control.fence,
        cursor: CURSOR,
        value: {
          ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
          cancelled: control.mode !== 'decline'
        }
      }
      const ending = turns.find((turn) => turn.turnId === params.turnId)
      if (control.completeOnCancel !== null && ending) {
        complete(ending.messageId, control.completeOnCancel)
      }
      if (control.mode === 'hang') {
        await new Promise<void>((resolve) => hung.push(resolve))
        return answer
      }
      return answer
    }
  }
  return {
    host,
    calls,
    control,
    turns,
    subscribers,
    /** The turn a run dispatched, visible to the journal from now on. */
    startTurn(turn: Omit<FakeTurn, 'state'> & { state?: FakeTurn['state'] }): void {
      turns.push({ state: 'running', ...turn })
    },
    /** The agent's own turn ends; its completion event is what a run watch reacts to. */
    completeTurn: complete,
    /** The host's status feed announces a change to one session. */
    emitStatus(sessionId: string): void {
      for (const subscriber of statusSubscribers.values()) {
        subscriber.emit({
          type: 'status',
          session: {
            sessionId,
            workspaceId: 'folder-1',
            agent: 'claude',
            status: null,
            latestPrompt: '',
            updatedAt: 1
          }
        })
      }
    },
    statusSubscriberCount: () => statusSubscribers.size,
    historyReads: () => historyReads,
    /** Holds every journal read until the returned release is called. */
    holdHistory(): () => void {
      let release: () => void = () => undefined
      historyGate = new Promise<void>((resolve) => {
        release = () => {
          historyGate = null
          resolve()
        }
      })
      return release
    },
    releaseHungCancels(): void {
      for (const release of hung.splice(0)) {
        release()
      }
    },
    subscribeTurnCompletions: (subscriber: {
      id: string
      emit: (event: AgentSessionTurnCompletionEvent) => void
    }) => {
      subscribers.set(subscriber.id, subscriber)
      return () => void subscribers.delete(subscriber.id)
    }
  }
}

/** A runtime whose host can be swapped, the way the structured registry replaces one. */
export function createFakeCancelRuntime(initial: ProjectEventRunCancelHost | null) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    runtime: {
      host: async () => current,
      onHostChanged: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    },
    replace(next: ProjectEventRunCancelHost | null): void {
      current = next
      for (const listener of listeners) {
        listener()
      }
    },
    listenerCount: () => listeners.size
  }
}
