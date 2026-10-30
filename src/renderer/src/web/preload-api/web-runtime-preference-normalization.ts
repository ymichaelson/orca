import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeProjectEventReceiverSettings } from '../../../../shared/project-event-receiver-settings'
import { normalizePRBotAuthorOverrides } from '../../../../shared/pr-bot-author-overrides'
import { runtimeChatPermissionSetting } from './web-preference-normalization'

export function normalizeRuntimePreferences(
  settings: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const runtimeSettings: Partial<GlobalSettings> = {}
  if (typeof settings.experimentalNewWorktreeCardStyle === 'boolean') {
    runtimeSettings.experimentalNewWorktreeCardStyle = settings.experimentalNewWorktreeCardStyle
  }
  if (typeof settings.compactWorktreeCards === 'boolean') {
    runtimeSettings.compactWorktreeCards = settings.compactWorktreeCards
  }
  if (typeof settings.minimaxGroupId === 'string') {
    runtimeSettings.minimaxGroupId = settings.minimaxGroupId
  }
  if (typeof settings.minimaxUsageModels === 'string') {
    runtimeSettings.minimaxUsageModels = settings.minimaxUsageModels
  }
  if (settings.minimaxEndpoint === 'overseas' || settings.minimaxEndpoint === 'cn') {
    runtimeSettings.minimaxEndpoint = settings.minimaxEndpoint
  }
  if (Array.isArray(settings.prBotAuthorOverrides)) {
    runtimeSettings.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
      settings.prBotAuthorOverrides
    )
  }
  Object.assign(runtimeSettings, runtimeChatPermissionSetting(settings))
  // Read-only mirror: the host owns this capability and `syncRuntimeBackedSettings` never
  // sends it back, so web shows what the host enforces instead of a local value it ignores.
  if (typeof settings.artifactSharingEnabled === 'boolean') {
    runtimeSettings.artifactSharingEnabled = settings.artifactSharingEnabled
  }
  if (typeof settings.agentSkillSharingEnabled === 'boolean') {
    runtimeSettings.agentSkillSharingEnabled = settings.agentSkillSharingEnabled
  }
  if (settings.projectEventReceiver !== undefined) {
    runtimeSettings.projectEventReceiver = normalizeProjectEventReceiverSettings(
      settings.projectEventReceiver
    )
  }
  return runtimeSettings
}
