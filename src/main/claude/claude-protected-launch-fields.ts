import type {
  AgentSessionProtectionFields,
  ProtectedClaudeLaunchV1
} from '../../shared/agent-session-protected-claude-launch'

export type ClaudeProtectedLaunchField = { protectedClaudeLaunch?: ProtectedClaudeLaunchV1 }

/** The ordinary resolver never launches a protected record; that path is the protected resolver's. */
export function refuseProtectedClaudeRecord(record: AgentSessionProtectionFields): void {
  if (record.protectedAnalysis || record.protectedClaudeLaunch) {
    throw new Error('protected_claude_launch_unavailable')
  }
}
