import type {
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult
} from '../../shared/ai-vault-types'
import { readAiVaultFirstUserPromptInBackground } from './session-scanner-background'
import { legacyTranscriptRowIsProtected } from './structured-session-ownership'

export function handleAiVaultGetFirstUserPrompt(
  args?: AiVaultFirstUserPromptArgs
): Promise<AiVaultFirstUserPromptResult> {
  if (
    !args ||
    typeof args.filePath !== 'string' ||
    typeof args.agent !== 'string' ||
    legacyTranscriptRowIsProtected({
      agent: args.agent,
      sessionId: args.sessionId,
      filePath: args.filePath
    })
  ) {
    return Promise.resolve({ prompt: null })
  }
  return readAiVaultFirstUserPromptInBackground({
    agent: args.agent,
    filePath: args.filePath,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    executionHostId: args.executionHostId,
    codexHome: args.codexHome
  })
}
