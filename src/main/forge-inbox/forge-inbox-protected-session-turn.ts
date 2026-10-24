import { randomUUID } from 'node:crypto'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import type { AgentSessionTurnCompletion } from '../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCurrentWork } from '../native-chat/agent-session-wire/structured-agent-session-current-work'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'
import { readForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'

/** No creation, replacement, or unfenced cancellation capability. */
export type ForgeProtectedSessionTurnHost = Pick<
  StructuredAgentSessionHost,
  'send' | 'waitForSendSettlement' | 'history' | 'subscribeTurnCompletions'
> & {
  currentWork: (
    sessionId: string
  ) => Pick<
    StructuredAgentSessionCurrentWork,
    'working' | 'hasActionablePrompt' | 'activeTurnId'
  > | null
  sessionRecord: (sessionId: string) =>
    | {
        lease: Pick<
          AgentSessionLease,
          'runtimeFence' | 'unreconciled' | 'handoffStage' | 'claimStatus'
        >
      }
    | null
    | undefined
}

/** A wait/readback deadline, NOT a provider token or spend cap. */
export const FORGE_PROTECTED_TURN_DEADLINE_MS = 60_000
const MAX_COMPLETION_CANDIDATES = 32

export type ForgeProtectedTurnOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'refused' }
  | { kind: 'unknown' }

/** Fail-closed per session: without terminal proof of this exact id it never lifts, so no fresh
 *  send may follow an unknown handoff. This deliberately bounds functionality, not cost. */
type Quarantine = { clientMessageId: string }
type HostTurns = { queues: Map<string, Promise<void>>; quarantines: Map<string, Quarantine> }
const turns = new WeakMap<ForgeProtectedSessionTurnHost, HostTurns>()

type TurnInput = {
  host: ForgeProtectedSessionTurnHost
  callerKey: string
  sessionId: string
  fence: number
  prompt: string
  signal: AbortSignal
}

/** Every protected caller shares the whole turn lane, not merely send admission. */
export async function sendForgeProtectedSessionTurn(
  input: TurnInput
): Promise<ForgeProtectedTurnOutcome> {
  if (input.signal.aborted) {
    return { kind: 'refused' }
  }
  const state = turns.get(input.host) ?? { queues: new Map(), quarantines: new Map() }
  turns.set(input.host, state)
  const controller = new AbortController()
  const abort = () => controller.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, FORGE_PROTECTED_TURN_DEADLINE_MS)
  let attempted = false
  try {
    const task = runKeyedSerializedOperation(state.queues, input.sessionId, () =>
      runTurn({ ...input, signal: controller.signal }, state, () => {
        attempted = true
      })
    )
    try {
      return (
        (await waitOrAbort(task, controller.signal)) ?? {
          kind: attempted ? 'unknown' : 'refused'
        }
      )
    } catch {
      return { kind: attempted ? 'unknown' : 'refused' }
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', abort)
    controller.abort()
  }
}

async function runTurn(
  input: TurnInput,
  state: HostTurns,
  onAttempt: () => void
): Promise<ForgeProtectedTurnOutcome> {
  const { host, sessionId, signal } = input
  if (signal.aborted) {
    return { kind: 'refused' }
  }
  const quarantined = state.quarantines.get(sessionId)
  let keepQuarantine = quarantined !== undefined
  let guarded = false
  let wake: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  try {
    if (quarantined) {
      const proof = await waitOrAbort(
        readForgeProtectedTurnProof(host, sessionId, quarantined.clientMessageId),
        signal
      )
      if (signal.aborted) {
        return { kind: 'refused' }
      }
      // Only the exact original request's terminal row ends the quarantine.
      if (!proof?.terminal) {
        return { kind: 'unknown' }
      }
      state.quarantines.delete(sessionId)
      keepQuarantine = false
    }
    // Opens at rest, never starts a provider; currentWork is unavailable on an unopened record.
    const opened = await waitOrAbort(
      host.history({ sessionId, direction: 'tail', limit: 1 }, 'own-agent'),
      signal
    )
    if (!opened?.ok || signal.aborted || !ready(host, sessionId, input.fence)) {
      return { kind: 'refused' }
    }
    const candidates = new Map<string, AgentSessionTurnCompletion>()
    let ended = false
    let overflow = false
    unsubscribe = host.subscribeTurnCompletions({
      id: randomUUID(),
      emit: (event) => {
        if (event.type === 'end') {
          ended = true
        }
        if (event.type === 'completion' && event.completion.sessionId === sessionId) {
          if (candidates.size >= MAX_COMPLETION_CANDIDATES) {
            overflow = true
          } else {
            candidates.set(event.completion.turnId, event.completion)
          }
        }
        wake?.()
      }
    })
    if (signal.aborted) {
      return { kind: 'refused' }
    }
    // The host's operation ledger refuses ids without its timestamp shape.
    const operationId = createStructuredAgentSessionOperationId(randomUUID)
    state.quarantines.set(sessionId, { clientMessageId: operationId })
    keepQuarantine = true
    onAttempt()
    const sending = sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId,
      callerKey: input.callerKey,
      turn: {
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: input.prompt }] },
        operationId,
        expectedRuntimeFence: input.fence,
        delivery: 'now',
        // The host does not check expectedRuntimeFence on send; this synchronous admission check
        // against the durable lease is what keeps a stale fence from reaching handoff.
        beforeRun: () => {
          if (signal.aborted || !ready(host, sessionId, input.fence)) {
            guarded = true
            throw new Error('forge_protected_turn_not_idle')
          }
        }
      },
      signal
    })
    void sending.catch(() => undefined)
    const sent = await waitOrAbort(sending, signal)
    // Our own pre-handoff throw proves no durable write. A host refusal of an unknown operation
    // proves nothing about delivery, so only that case keeps the quarantine.
    if (guarded) {
      keepQuarantine = false
      return { kind: 'refused' }
    }
    if (sent?.kind === 'refused') {
      if (sent.refusal.code !== 'agent_session_operation_unknown') {
        keepQuarantine = false
        return { kind: 'refused' }
      }
      return { kind: 'unknown' }
    }
    if (
      !sent ||
      signal.aborted ||
      sent.kind !== 'sent' ||
      sent.clientMessageId !== operationId ||
      sent.submission?.dispatchState !== 'accepted'
    ) {
      return { kind: 'unknown' }
    }
    while (!signal.aborted && !ended) {
      if (overflow) {
        return { kind: 'unknown' }
      }
      let notify: (() => void) | undefined
      const changed = new Promise<void>((resolve) => {
        notify = resolve
      })
      wake = notify
      const proof = await waitOrAbort(
        readForgeProtectedTurnProof(host, sessionId, operationId),
        signal
      )
      if (signal.aborted) {
        return { kind: 'unknown' }
      }
      const completion = proof ? candidates.get(proof.turnId) : undefined
      if (proof?.terminal && completion) {
        keepQuarantine = false
        return proof.outcome === 'success' &&
          completion.outcome === 'success' &&
          completion.awaitingUser !== true &&
          proof.text !== null
          ? { kind: 'reply', text: proof.text }
          : { kind: 'unknown' }
      }
      if (ended || overflow) {
        return { kind: 'unknown' }
      }
      await waitOrAbort(changed, signal)
    }
    return { kind: 'unknown' }
  } catch {
    if (guarded) {
      keepQuarantine = false
      return { kind: 'refused' }
    }
    return { kind: 'unknown' }
  } finally {
    wake = undefined
    unsubscribe?.()
    if (!keepQuarantine) {
      state.quarantines.delete(sessionId)
    }
  }
}

function ready(host: ForgeProtectedSessionTurnHost, sessionId: string, fence: number): boolean {
  const lease = host.sessionRecord(sessionId)?.lease
  const work = host.currentWork(sessionId)
  return (
    lease !== undefined &&
    lease.runtimeFence === fence &&
    lease.unreconciled === false &&
    lease.handoffStage === null &&
    (lease.claimStatus === 'live' || lease.claimStatus === 'released') &&
    work !== null &&
    !work.working() &&
    !work.hasActionablePrompt()
  )
}

function waitOrAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      resolve(null)
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
