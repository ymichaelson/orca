import type { AgentType } from '../../shared/native-chat-types'
import { agentHookServer } from '../agent-hooks/server'
import { nativeChatTranscriptPathOnExecutionHost } from '../native-chat/ssh-transcript-path'
import { PROTECTED_TRANSCRIPT_REFUSAL } from '../../shared/agent-session-protected-output-capability'
import { legacyTranscriptRowIsProtected } from '../ai-vault/structured-session-ownership'

/** Resolves the host transcript path; a protected session's raw transcript is refused first. */
export function resolveNativeChatTranscriptRead(args: {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
}): { transcriptPath: string | undefined; refusal: string | null } {
  const transcriptPath = nativeChatTranscriptPathOnExecutionHost(
    agentHookServer.getStatusSnapshot(),
    args.sessionId,
    args.transcriptPath
  )
  // Why: this reader hands raw transcript text to the renderer, which is not the inert
  // rendering a protected analysis requires.
  const refusal = legacyTranscriptRowIsProtected({
    agent: args.agent,
    sessionId: args.sessionId,
    filePath: transcriptPath ?? ''
  })
    ? PROTECTED_TRANSCRIPT_REFUSAL
    : null
  return { transcriptPath, refusal }
}
