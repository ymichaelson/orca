import { startForgeInboxForHost } from '../forge-inbox/forge-inbox-host-startup'
import { forgeInboxAnalysisForRuntime } from '../forge-inbox/forge-inbox-analysis-runtime'
import { forgeInboxDiscussForRuntime } from '../forge-inbox/forge-inbox-discuss-runtime'
import { getMainHttpClient } from '../network/http-client'
import { mainProcessState as state } from './main-process-state'

/** One owner service per profile; a failed start is logged and never blocks the rest of startup. */
export async function initializeMainProcessForgeInbox(): Promise<void> {
  const runtime = state.runtime
  const profile = state.activeOrcaProfile
  if (!runtime || !profile) {
    throw new Error('Runtime and active profile must be initialized before the forge inbox')
  }
  const http = getMainHttpClient()
  await startForgeInboxForHost({
    profileDirectory: profile.profileDirectory,
    http,
    networkReady: state.initialProxyApplicationReady,
    attach: (service) => runtime.attachForgeInboxService(service),
    notify: (event) => runtime.dispatchMobileNotification(event),
    analyse: forgeInboxAnalysisForRuntime({
      runtime: {
        requireStore: () => runtime.requireStore(),
        resolveRuntimeFileTarget: (selector) => runtime.resolveRuntimeFileTarget(selector),
        ensureStructuredAgentSessionHost: () => runtime.ensureStructuredAgentSessionHost()
      },
      http
    }),
    discuss: forgeInboxDiscussForRuntime({
      ensureStructuredAgentSessionHost: () => runtime.ensureStructuredAgentSessionHost()
    })
  })
}
