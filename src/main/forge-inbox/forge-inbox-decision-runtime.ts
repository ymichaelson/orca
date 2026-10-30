import { createProjectEventDecisionClient } from '../project-events/project-event-decision-client'
import {
  decisionApiKeyForProvider,
  decisionClientBaseUrl,
  normalizeProjectEventDecisionSettings,
  type ProjectEventDecisionKeyFields,
  type ProjectEventDecisionSettings
} from '../../shared/project-event-decision-settings'
import type {
  ProjectEventDecisionInput,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { MainHttpClient } from '../network/http-client'

export type ProjectEventDecisionSource = {
  read: () => { settings: ProjectEventDecisionSettings; apiKey: string }
}

export function projectEventDecisionSourceForSettings(
  getSettings: () => ProjectEventDecisionKeyFields & {
    projectEventDecision?: ProjectEventDecisionSettings
  }
): ProjectEventDecisionSource {
  return {
    read: () => {
      const current = getSettings()
      const settings = normalizeProjectEventDecisionSettings(current.projectEventDecision)
      return { settings, apiKey: decisionApiKeyForProvider(settings.provider, current) }
    }
  }
}

/**
 * Reads the host's saved provider, model and key on every decision, so a change takes effect
 * without restarting. A missing key or Laya address returns the client's invalid-config result.
 */
export function projectEventDecisionForSource(
  source: ProjectEventDecisionSource,
  http: Pick<MainHttpClient, 'fetch'>
): (input: ProjectEventDecisionInput, signal?: AbortSignal) => Promise<ProjectEventDecisionResult> {
  return (input, signal) => {
    const current = source.read()
    const settings = normalizeProjectEventDecisionSettings(current.settings)
    const baseUrl = decisionClientBaseUrl(settings)
    return createProjectEventDecisionClient({
      provider: settings.provider,
      http,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(settings.model === '' ? {} : { model: settings.model }),
      ...(current.apiKey === '' ? {} : { apiKey: current.apiKey })
    })(input, signal)
  }
}
