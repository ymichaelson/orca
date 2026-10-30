import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  activateAiVaultStructuredSession,
  revealStructuredSessionOnHost,
  structuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'

/**
 * Opens a persisted chat known only by id on the host that owns it; never starts or sends anything.
 * True means the chat is now the active tab, so a caller on a page of its own can step aside.
 */
export async function openStructuredSessionById(
  sessionId: string,
  target: RuntimeClientTarget
): Promise<boolean> {
  const { outcome, workspaceId } = await revealStructuredSessionOnHost(sessionId, target)
  if (outcome === 'revealed' && workspaceId !== null) {
    return activateAiVaultStructuredSession(
      { structuredSession: { workspaceId, sessionId } },
      undefined,
      target
    )
  }
  if (outcome === 'gone') {
    structuredSessionOpenFeedback.gone()
  } else if (outcome === 'unreachable') {
    structuredSessionOpenFeedback.unavailable()
  } else {
    structuredSessionOpenFeedback.hostCannotOpen()
  }
  return false
}
