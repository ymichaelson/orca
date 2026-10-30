import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY,
  type ProjectEventDecisionManagementView,
  type ProjectEventDecisionSettings
} from '../../../shared/project-event-decision-settings'
import type {
  ProjectEventDecisionProbeResult,
  ProjectEventDecisionProvider
} from '../../../shared/project-event-decision'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

type DecisionSettingsActions = {
  getSettings: { ownerHostId: string }
  saveSettings: { ownerHostId: string; settings: ProjectEventDecisionSettings }
  saveApiKey: { ownerHostId: string; provider: ProjectEventDecisionProvider; apiKey: string }
  clearApiKey: { ownerHostId: string; provider: ProjectEventDecisionProvider }
}

export async function callProjectEventDecisionSettings<
  Action extends keyof DecisionSettingsActions
>(
  target: RuntimeClientTarget,
  action: Action,
  params: DecisionSettingsActions[Action]
): Promise<ProjectEventDecisionManagementView> {
  try {
    if (
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY
      ))
    ) {
      throw new Error('unavailable')
    }
    return await callRuntimeRpc<ProjectEventDecisionManagementView>(
      target,
      `projectEventDecision.${action}`,
      params
    )
  } catch {
    throw new Error('project_event_decision_unavailable')
  }
}

/** One user-triggered real probe request; the result carries no key or request body. */
export async function testProjectEventDecisionConnection(
  target: RuntimeClientTarget,
  params: { ownerHostId: string }
): Promise<ProjectEventDecisionProbeResult> {
  try {
    if (
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY
      ))
    ) {
      throw new Error('unavailable')
    }
    return await callRuntimeRpc<ProjectEventDecisionProbeResult>(
      target,
      'projectEventDecision.testConnection',
      params,
      { timeoutMs: 20_000 }
    )
  } catch {
    throw new Error('project_event_decision_unavailable')
  }
}
