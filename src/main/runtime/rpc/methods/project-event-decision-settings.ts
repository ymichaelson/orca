import { protectedSecretStorageAvailable } from '../../../protected-secret-persistence'
import {
  parseProjectEventDecisionSettings,
  type ProjectEventDecisionManagementView
} from '../../../../shared/project-event-decision-settings'
import {
  ProjectEventDecisionClearApiKeyParams,
  ProjectEventDecisionOwnerParams,
  ProjectEventDecisionSaveApiKeyParams,
  ProjectEventDecisionSaveSettingsParams
} from '../../../../shared/rpc-contract/project-event-decision-settings-params'
import type { ProjectEventDecisionProvider } from '../../../../shared/project-event-decision'
import { defineMethod, type RpcContext } from '../core'

function protection(): 'available' | 'unavailable' {
  return protectedSecretStorageAvailable() ? 'available' : 'unavailable'
}

/** Writes the one key field that belongs to the requested provider. */
function apiKeyUpdate(
  provider: ProjectEventDecisionProvider,
  apiKey: string
): Parameters<RpcContext['runtime']['updateDecisionSettings']>[0] {
  return provider === 'laya'
    ? { projectEventDecisionLayaKey: apiKey }
    : { projectEventDecisionKey: apiKey }
}

function manage(
  context: RpcContext,
  ownerHostId: string,
  updates?: Parameters<RpcContext['runtime']['updateDecisionSettings']>[0]
): ProjectEventDecisionManagementView {
  // The dispatcher forwards messages; neither backend errors nor protection diagnostics may escape.
  try {
    if (!context.runtime.supportsDecisionSettingsManagement()) {
      throw new Error('unavailable')
    }
    const service = context.runtime.forgeInboxServiceIfAttached()
    if (!service || service.ownerHostId() !== ownerHostId) {
      throw new Error('unavailable')
    }
    // Why only a non-empty write needs protection: clearing must stay possible on a host whose
    // keyring broke, otherwise a saved key could never be removed.
    if (
      updates &&
      (updates.projectEventDecisionKey || updates.projectEventDecisionLayaKey) &&
      protection() !== 'available'
    ) {
      throw new Error('unavailable')
    }
    const settings = updates
      ? context.runtime.updateDecisionSettings(updates)
      : context.runtime.getDecisionSettings()
    return { ownerHostId, settings, protection: protection() }
  } catch {
    throw new Error('project_event_decision_unavailable')
  }
}

async function testConnection(context: RpcContext, ownerHostId: string) {
  try {
    if (!context.runtime.supportsDecisionSettingsManagement()) {
      throw new Error('unavailable')
    }
    const service = context.runtime.forgeInboxServiceIfAttached()
    if (!service || service.ownerHostId() !== ownerHostId) {
      throw new Error('unavailable')
    }
    return await context.runtime.probeDecisionConnection(context.signal)
  } catch {
    throw new Error('project_event_decision_unavailable')
  }
}

export const PROJECT_EVENT_DECISION_SETTINGS_METHODS = [
  defineMethod({
    name: 'projectEventDecision.getSettings',
    permission: 'workspace',
    params: ProjectEventDecisionOwnerParams,
    handler: ({ ownerHostId }, context) => manage(context, ownerHostId)
  }),
  defineMethod({
    name: 'projectEventDecision.saveSettings',
    permission: 'settings-write',
    params: ProjectEventDecisionSaveSettingsParams,
    handler: ({ ownerHostId, settings }, context) =>
      manage(context, ownerHostId, {
        projectEventDecision: parseProjectEventDecisionSettings(settings)
      })
  }),
  defineMethod({
    name: 'projectEventDecision.saveApiKey',
    permission: 'accounts-admin',
    params: ProjectEventDecisionSaveApiKeyParams,
    handler: ({ ownerHostId, provider, apiKey }, context) =>
      manage(context, ownerHostId, apiKeyUpdate(provider, apiKey))
  }),
  defineMethod({
    name: 'projectEventDecision.clearApiKey',
    permission: 'accounts-admin',
    params: ProjectEventDecisionClearApiKeyParams,
    handler: ({ ownerHostId, provider }, context) =>
      manage(context, ownerHostId, apiKeyUpdate(provider, ''))
  }),
  defineMethod({
    name: 'projectEventDecision.testConnection',
    permission: 'settings-write',
    params: ProjectEventDecisionOwnerParams,
    handler: ({ ownerHostId }, context) => testConnection(context, ownerHostId)
  })
] as const
