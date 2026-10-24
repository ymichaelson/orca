import {
  agentSessionProtectedAnalysisEqual,
  type AgentSessionProtectedAnalysis
} from '../../shared/agent-session-protected-analysis'
import {
  isProtectedClaudeRecordBinding,
  protectedClaudeLaunchSchema
} from '../../shared/agent-session-protected-claude-launch'

/** What a protected turn reads of a session record: which item it was founded for, and its fence. */
export type ForgeProtectedSessionRecord = {
  protectedAnalysis?: AgentSessionProtectedAnalysis
  protectedClaudeLaunch?: unknown
  provider?: unknown
  schemaVersion?: unknown
  accountHome?: unknown
  options?: unknown
  permissionMode?: unknown
  launchArgs?: unknown
  lease: { runtimeFence: number }
}

/** Binding alone treats an absent launch marker as accepted; protected work requires the marker. */
export function isForgeProtectedSessionFor(
  record: ForgeProtectedSessionRecord,
  subject: AgentSessionProtectedAnalysis
): boolean {
  return (
    isProtectedClaudeRecordBinding(record) &&
    protectedClaudeLaunchSchema.safeParse(record.protectedClaudeLaunch).success &&
    agentSessionProtectedAnalysisEqual(record.protectedAnalysis, subject)
  )
}
