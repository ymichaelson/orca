import type { CanUseTool, OnUserDialog } from '@anthropic-ai/claude-agent-sdk'
import type { ProtectedClaudeLaunchV1 } from '../../shared/agent-session-protected-claude-launch'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'

export type ClaudeStreamJsonLaunch = {
  /** Present only for a durable protected record; the transport then seals itself to the profile. */
  protectedClaudeLaunch?: ProtectedClaudeLaunchV1
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  /** Removed after the child's env is built over Orca's own, as every provider child's are. */
  envToDelete?: readonly string[]
}

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  /**
   * The SDK owns inbound permission control: it hands `can_use_tool` to this callback with
   * a stable requestId and an abort signal, dedups duplicate delivery, and matches the
   * response by request_id itself. Setting it makes the SDK pass `--permission-prompt-tool
   * stdio` automatically; it must not be paired with `permissionPromptToolName`.
   */
  canUseTool?: CanUseTool
  /** `request_user_dialog` control; the CLI only emits kinds declared in `supportedDialogKinds`. */
  onUserDialog?: OnUserDialog
  /** A transport/process fault that is not itself first-hand root exit proof. */
  onFault?: (error: Error) => void
  /** The root process exited, reported once. `expected`: a close had begun, so it is that close's
   *  end, even one that ran out of its own escalation first and came back unproven. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
}

/**
 * Two questions with their own evidence. The root's verdict is first-hand: Orca's
 * own child handle reported exit, or reported error then close before it ever had
 * a pid. The tree's comes from bounded descendant verification, and `unverifiable`
 * is never collapsed into either neighbour.
 */
export type ClaudeChildExitVerdict = {
  root: DescendantTreeVerdict
  tree: DescendantTreeVerdict
  processless?: boolean
}
