import { isAgentNeedsInputAlert } from './mobile-push-alert'
import type { NotificationSettings } from './notification-settings-types'

type SourceGateSettings = Pick<
  NotificationSettings,
  'enabled' | 'agentTaskComplete' | 'agentNeedsInput' | 'terminalBell' | 'forgeInboxCompletedRuns'
>

/** Ordinary success is recorded in the Inbox; it only interrupts once completed runs are opted in. */
function forgeInboxAllowed(
  settings: Pick<SourceGateSettings, 'forgeInboxCompletedRuns'>,
  source: string,
  subjectReason: string | undefined
): boolean {
  return (
    source !== 'forge-inbox' ||
    subjectReason !== 'run-succeeded' ||
    settings.forgeInboxCompletedRuns === true
  )
}

/** The desktop's per-source preferences; paired phones receive an alert only when this allows it. */
export function isNotificationSourceEnabled(
  settings: SourceGateSettings,
  source: string,
  agentState: string | undefined,
  subjectReason?: string
): boolean {
  if (!settings.enabled) {
    return false
  }
  if (source === 'terminal-bell') {
    return settings.terminalBell
  }
  if (source === 'forge-inbox') {
    return forgeInboxAllowed(settings, source, subjectReason)
  }
  if (source !== 'agent-task-complete') {
    return true
  }
  return isAgentNeedsInputAlert(source, agentState)
    ? settings.agentNeedsInput
    : settings.agentTaskComplete
}
