import {
  decisionApiKeyForProvider,
  normalizeProjectEventDecisionSettings,
  projectEventDecisionSettingsView,
  type ProjectEventDecisionSettings
} from '../../shared/project-event-decision-settings'
import { PROTECTED_SECRET_SLOT } from '../protected-secret-persistence'
import { probeProjectEventDecisionConnection } from '../forge-inbox/forge-inbox-decision-probe'
import { getMainHttpClient } from '../network/http-client'
import type {
  ProjectEventDecisionProbeResult,
  ProjectEventDecisionProvider
} from '../../shared/project-event-decision'
import type { RuntimeStore } from './runtime-store-contract'

type DecisionKeyPresence = Pick<RuntimeStore, 'getSettings' | 'hasSealedProtectedSecret'>

type DecisionStore = Pick<
  RuntimeStore,
  'getSettings' | 'updateSettings' | 'hasSealedProtectedSecret'
>

type ProjectEventDecisionSettingsUpdate = {
  projectEventDecision?: ProjectEventDecisionSettings
  projectEventDecisionKey?: string
  projectEventDecisionLayaKey?: string
}

/** Keys whose ciphertext survived a keyring failure are unusable, but must stay clearable. */
export function sealedDecisionKeys(
  store: DecisionKeyPresence
): Partial<Record<ProjectEventDecisionProvider, boolean>> {
  return {
    jev: store.hasSealedProtectedSecret?.(PROTECTED_SECRET_SLOT.projectEventDecisionKey) === true,
    laya:
      store.hasSealedProtectedSecret?.(PROTECTED_SECRET_SLOT.projectEventDecisionLayaKey) === true
  }
}

export function supportsDecisionManagement(store: DecisionStore | null): boolean {
  return Boolean(store?.getSettings && store.updateSettings)
}

export function getDecisionSettings(store: DecisionKeyPresence | null) {
  if (!store?.getSettings) {
    throw new Error('project_event_decision_unavailable')
  }
  const settings = store.getSettings()
  return projectEventDecisionSettingsView(
    normalizeProjectEventDecisionSettings(settings.projectEventDecision),
    settings,
    sealedDecisionKeys(store)
  )
}

export function updateDecisionSettings(
  store: DecisionStore | null,
  updates: ProjectEventDecisionSettingsUpdate
) {
  if (!supportsDecisionManagement(store) || !store?.updateSettings) {
    throw new Error('project_event_decision_unavailable')
  }
  store.updateSettings(updates, { notifyListeners: true })
  return getDecisionSettings(store)
}

/** Runs one bounded real request with the saved settings; never returns the key. */
export async function probeDecisionConnection(
  store: DecisionKeyPresence | null,
  signal?: AbortSignal
): Promise<ProjectEventDecisionProbeResult> {
  if (!store?.getSettings) {
    throw new Error('project_event_decision_unavailable')
  }
  const current = store.getSettings()
  const settings = normalizeProjectEventDecisionSettings(current.projectEventDecision)
  return await probeProjectEventDecisionConnection({
    settings,
    apiKey: decisionApiKeyForProvider(settings.provider, current),
    http: getMainHttpClient(),
    ...(signal ? { signal } : {})
  })
}
