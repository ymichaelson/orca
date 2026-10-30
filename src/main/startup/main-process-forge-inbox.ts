import { startForgeInboxForHost } from '../forge-inbox/forge-inbox-host-startup'
import { projectEventDecisionSourceForSettings } from '../forge-inbox/forge-inbox-decision-runtime'
import { forgeInboxProjectBindingContextForRuntime } from '../forge-inbox/forge-inbox-project-binding-runtime'
import { forgeInboxProjectEventAgentLaunchForRuntime } from '../forge-inbox/forge-inbox-project-event-agent-launch'
import { forgeInboxProjectEventRunRecoveryForRuntime } from '../forge-inbox/forge-inbox-project-event-run-recovery-runtime'
import { getMainHttpClient } from '../network/http-client'
import { projectEventReceiverSettingsForStore } from '../project-events/project-event-receiver-settings-source'
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
    receiverSettings: projectEventReceiverSettingsForStore(runtime.requireStore()),
    decisionSource: projectEventDecisionSourceForSettings(() =>
      runtime.requireStore().getSettings()
    ),
    launchProjectEventAgent: forgeInboxProjectEventAgentLaunchForRuntime(runtime),
    recoverProjectEventRuns: forgeInboxProjectEventRunRecoveryForRuntime({
      ensureHost: () => runtime.ensureStructuredAgentSessionHost()
    }),
    resolveProjectBindingContext: forgeInboxProjectBindingContextForRuntime({
      requireStore: () => runtime.requireStore()
    }),
    networkReady: state.initialProxyApplicationReady,
    attach: (service) => runtime.attachForgeInboxService(service),
    notify: (event) => runtime.dispatchMobileNotification(event)
  })
}
