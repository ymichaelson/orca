import { randomUUID } from 'node:crypto'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import { protectedClaudePrivatePath } from '../../shared/agent-session-protected-claude-launch'
import type { prepareProtectedClaudeFounding } from '../runtime/agent-session-protected-claude-founding'
import type { ForgeAnalysisTurn } from './forge-inbox-analysis-runner'

export type ForgeProtectedAnalysisFounding = Awaited<
  ReturnType<typeof prepareProtectedClaudeFounding>
>

export type ForgeProtectedAnalysisSession = {
  /** The assistant text, or null when the turn's outcome cannot be proven. */
  sendTurn(prompt: string, signal: AbortSignal): Promise<string | null>
}

export type ForgeProtectedAnalysisOpenRequest = {
  sessionId: string
  subject: AgentSessionProtectedAnalysis
  founding: ForgeProtectedAnalysisFounding
  /** The private work directory; never a workspace or repository path. */
  launchDirectory: string
}

export type ForgeProtectedAnalysisTurnDeps = {
  /** Host-owned: picks the auth source, model and location, then prepares the protected founding. */
  foundFor: (input: {
    sessionId: string
    subject: AgentSessionProtectedAnalysis
  }) => Promise<ForgeProtectedAnalysisFounding>
  openSession: (input: ForgeProtectedAnalysisOpenRequest) => Promise<ForgeProtectedAnalysisSession>
}

/** The only piece that may open a protected analysis session; hosts wire it once the reader fences land. */
export function createForgeProtectedAnalysisTurn(
  deps: ForgeProtectedAnalysisTurnDeps
): ForgeAnalysisTurn {
  return async ({ prompt, signal, subject, onSession }) => {
    if (signal.aborted) {
      return { kind: 'unknown' }
    }
    const sessionId = randomUUID()
    const founding = await deps.foundFor({ sessionId, subject })
    if (signal.aborted) {
      return { kind: 'unknown' }
    }
    const { privateRoot } = founding.protectedClaudeLaunch
    // The founding is host-supplied, so the binding that keeps the CLI out of the user's own
    // config is re-checked rather than assumed.
    if (founding.accountHome.path !== protectedClaudePrivatePath(privateRoot, 'config')) {
      throw new Error('protected_claude_founding_unavailable')
    }
    // Bound before the session opens: opening is what starts the provider child.
    onSession(sessionId)
    const session = await deps.openSession({
      sessionId,
      subject,
      founding,
      launchDirectory: protectedClaudePrivatePath(privateRoot, 'work')
    })
    const text = await session.sendTurn(prompt, signal)
    return text === null ? { kind: 'unknown' } : { kind: 'reply', text }
  }
}
