import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

/** The model and effort the chat was created with, which its opening message runs on as a send's
 *  carried ones do. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
