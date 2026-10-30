import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  activateAiVaultStructuredSession,
  revealStructuredSessionOnHost,
  structuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'

/** Opens a persisted chat known only by id on the host that owns it; never starts or sends anything. */
export async function openStructuredSessionById(
  sessionId: string,
  target: RuntimeClientTarget
): Promise<void> {
  const { outcome, workspaceId } = await revealStructuredSessionOnHost(sessionId, target)
  if (outcome === 'revealed' && workspaceId !== null) {
    await activateAiVaultStructuredSession(
      { structuredSession: { workspaceId, sessionId } },
      undefined,
      target
    )
  } else if (outcome === 'gone') {
    structuredSessionOpenFeedback.gone()
  } else if (outcome === 'unreachable') {
    structuredSessionOpenFeedback.unavailable()
  } else {
    structuredSessionOpenFeedback.hostCannotOpen()
  }
}
