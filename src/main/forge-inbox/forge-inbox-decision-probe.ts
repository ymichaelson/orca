import { createProjectEventDecisionClient } from '../project-events/project-event-decision-client'
import {
  decisionClientBaseUrl,
  normalizeProjectEventDecisionSettings,
  type ProjectEventDecisionSettings
} from '../../shared/project-event-decision-settings'
import type { ProjectEventDecisionProbeResult } from '../../shared/project-event-decision'
import type { MainHttpClient } from '../network/http-client'

// One real bounded inference: the probe proves the saved settings, key and endpoint work.
const PROBE_INPUT = {
  rules: 'This is a connection test. Choose record_only and take no action.',
  event: { kind: 'connection-test' }
} as const

export async function probeProjectEventDecisionConnection(input: {
  settings: ProjectEventDecisionSettings
  apiKey: string
  http: Pick<MainHttpClient, 'fetch'>
  signal?: AbortSignal
}): Promise<ProjectEventDecisionProbeResult> {
  const settings = normalizeProjectEventDecisionSettings(input.settings)
  const baseUrl = decisionClientBaseUrl(settings)
  const decide = createProjectEventDecisionClient({
    provider: settings.provider,
    http: input.http,
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(settings.model === '' ? {} : { model: settings.model }),
    ...(input.apiKey === '' ? {} : { apiKey: input.apiKey })
  })
  const result = await decide(PROBE_INPUT, input.signal)
  return result.ok
    ? {
        ok: true,
        provider: result.provider,
        model: result.model,
        usedDefaultModel: settings.model === ''
      }
    : { ok: false, code: result.code }
}
