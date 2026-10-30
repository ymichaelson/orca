import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import { boundedCall } from './forge-inbox-bounded-call'
import type { ProjectEventRunCancelHost } from './forge-inbox-project-event-run-cancel'
import type { RunCancelRequest } from './forge-inbox-project-event-run-cancel-state'
import { readForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'

/** The host's own Stop, naming one proven turn at the fence just read, under the request's durable id. */
export function requestTurnStop(
  host: ProjectEventRunCancelHost,
  request: Pick<RunCancelRequest, 'runId' | 'sessionId'>,
  stop: { operationId: string; fence: number; turnId: string }
): ReturnType<ProjectEventRunCancelHost['cancel']> {
  return host.cancel(
    { callerKey: `forge-dispatch:${request.runId}` },
    {
      envelope: {
        sessionId: request.sessionId,
        clientOperationId: stop.operationId,
        expectedRuntimeFence: stop.fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: request.sessionId,
          fields: { turnId: stop.turnId }
        })
      },
      turnId: stop.turnId
    }
  )
}

/** A receipt that interrupted nothing is a late no-op only when the turn's own proof says it ended. */
export async function ownTurnEnded(
  host: ProjectEventRunCancelHost,
  request: Pick<RunCancelRequest, 'sessionId' | 'clientMessageId'>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<boolean> {
  const proved = await boundedCall(
    signal,
    readForgeProtectedTurnProof(host, request.sessionId, request.clientMessageId),
    timeoutMs
  )
  return proved.ok && proved.value?.terminal === true
}
