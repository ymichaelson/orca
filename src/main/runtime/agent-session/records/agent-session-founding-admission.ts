import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { isAgentSessionProtectedAnalysis } from '../../../../shared/agent-session-protected-analysis'
import {
  isProtectedClaudeRecordBinding,
  type AgentSessionProtectionFields
} from '../../../../shared/agent-session-protected-claude-launch'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import {
  assertAdoptedConversationUnowned,
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  validateAgentSessionReservationInput,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from '../ownership/agent-session-reservation-admission'
import { assertReservedTabUnheld, setAgentSessionTabVisibility } from '../agent-session-tab-table'
import {
  selectWritableAgentSessionRecord,
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'

/** What host founding accepts; a reservation never carries the protection fields. */
export type AgentSessionFoundingRequest = AgentSessionReserveRequest & AgentSessionProtectionFields

/** Use create admission without requiring owner acquisition. */
export function commitAgentSessionFounding(
  state: AgentSessionStoreState,
  request: AgentSessionFoundingRequest,
  legacyIds: readonly string[] = []
): AgentSessionReserveResult {
  if (
    (request.protectedAnalysis !== undefined &&
      !isAgentSessionProtectedAnalysis(request.protectedAnalysis)) ||
    !isProtectedClaudeRecordBinding({
      ...request,
      schemaVersion: request.protectedAnalysis ? 3 : 2
    })
  ) {
    throw new Error('agent_session_store_write_invalid')
  }
  const decision = evaluateAgentSessionReserveOperation(state, request)
  if (decision.decision === 'refused') {
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision === 'replay') {
    return {
      record: requireAgentSessionRecordForReplay(state, decision.row, request.sessionId),
      disposition: 'replayed',
      operationRow: decision.row
    }
  }
  validateAgentSessionReservationInput(request)
  if (request.expectedFence !== null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const selected = selectWritableAgentSessionRecord(state, request.sessionId)
  if (selected.kind === 'unreadable') {
    requireWritableAgentSessionRecord(state, request.sessionId)
  }
  if (selected.kind === 'writable') {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  try {
    assertAdoptedConversationUnowned(state, request)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      throw new AgentSessionRefusalError({
        ...error.refusal,
        createAttemptRefusedBeforeCommit: true
      })
    }
    throw error
  }
  assertReservedTabUnheld(state, request, legacyIds)
  const founded = foundAgentSessionRecord(request, request)
  const record = request.adoptedHandleLink
    ? { ...founded, providerHandleChain: [request.adoptedHandleLink] }
    : founded
  const operationRow = {
    ...decision.row,
    outcome: { status: 'succeeded' as const, sessionId: request.sessionId }
  }
  state.records.set(request.sessionId, record)
  state.operations.set(
    agentSessionOperationKey(operationRow.callerKey, operationRow.operationId),
    operationRow
  )
  // A protected analysis record is host-owned and never appears in the tab surface.
  setAgentSessionTabVisibility(
    state,
    request.sessionId,
    request.protectedAnalysis === undefined,
    request.surfaceTabId,
    legacyIds
  )
  return { record, disposition: 'created', operationRow }
}
