import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { providerStderrForDisplay } from '../provider-process/provider-spawn-failure-report'

export type ClaudeExitStatus = { code: number | null; signal: NodeJS.Signals | null }

export function claudeStreamJsonExitError(
  stderrTail: string,
  status: ClaudeExitStatus | null,
  cause?: Error
): Error {
  const detail = providerStderrForDisplay(stderrTail).trim()
  // The status is the diagnostic a signed-out or refused start leaves behind;
  // it has to survive every wrapper between here and the user.
  const how =
    status?.signal !== null && status?.signal !== undefined
      ? ` (signal ${status.signal})`
      : status?.code !== null && status?.code !== undefined
        ? ` (code ${status.code})`
        : ''
  const message = `claude stream-json exited${how}${detail ? `: ${detail}` : ''}`
  // Written for a log, not a person: the chat keeps it behind Details.
  const diagnostic = providerDiagnostic([how.trim(), detail].filter(Boolean).join('\n'), 'log')
  return withProviderDiagnostic(
    cause ? new Error(message, { cause }) : new Error(message),
    diagnostic
  )
}
