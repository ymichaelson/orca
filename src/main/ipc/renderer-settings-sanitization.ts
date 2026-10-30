import type { GlobalSettings } from '../../shared/global-settings-types'

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

// Why both: each provider's key is host-only, and only the renderer's settings mirror strips them.
export function settingsWithoutDecisionKey<T extends Partial<GlobalSettings>>(
  settings: T
): Omit<T, 'projectEventDecisionKey' | 'projectEventDecisionLayaKey'> {
  const {
    projectEventDecisionKey: _key,
    projectEventDecisionLayaKey: _layaKey,
    ...visible
  } = settings
  void _key
  void _layaKey
  return visible
}

export function sanitizeRendererSettingsUpdate(
  args: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  // Plugin consent and enablement are main-owned authority state. Renderer
  // writes must pass the dedicated reviewed-fingerprint handlers.
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  delete sanitizedArgs.projectEventDecisionKey
  delete sanitizedArgs.projectEventDecisionLayaKey
  return sanitizedArgs
}
