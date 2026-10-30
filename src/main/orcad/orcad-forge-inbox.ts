import { startForgeInboxForHost } from '../forge-inbox/forge-inbox-host-startup'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'
import { forgeInboxProjectBindingContextForRuntime } from '../forge-inbox/forge-inbox-project-binding-runtime'
import type { ProjectBindingContextStore } from '../forge-inbox/forge-inbox-project-binding-context'
import type { ForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { MainHttpClient } from '../network/http-client'
import {
  projectEventDecisionSourceForSettings,
  type ProjectEventDecisionSource
} from '../forge-inbox/forge-inbox-decision-runtime'
import { projectEventReceiverSettingsForStore } from '../project-events/project-event-receiver-settings-source'
import type { ForgeInboxOwnerServiceOptions } from '../forge-inbox/forge-inbox-owner-service-options'
import type { ForgeProjectEventAgentLaunchFactory } from '../forge-inbox/forge-inbox-project-event-agent-launch'
import { forgeInboxProjectEventRunRecoveryForRuntime } from '../forge-inbox/forge-inbox-project-event-run-recovery-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

type OrcadForgeInboxRuntime = {
  requireStore: () => ProjectBindingContextStore & {
    getSettings: ProtectedClaudeAuthDeps['getSettings']
  }
  ensureStructuredAgentSessionHost: () => Promise<void>
  attachForgeInboxService(service: ForgeInboxOwnerService): void
  stopForgeInboxService(): Promise<void>
  dispatchMobileNotification(event: MobileNotificationDispatchEvent): void
}

/** The stop is registered before the start is awaited, and the service is attached before it starts, so a shutdown mid-start still closes it. */
export async function startOrcadForgeInbox(input: {
  runtime: OrcadForgeInboxRuntime
  profileDirectory: string
  /** When given, the project-event receiver and decision sources are derived here for the host. */
  store?: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'>
  receiverSettings?: ForgeInboxOwnerServiceOptions['receiverSettings']
  decisionSource?: ProjectEventDecisionSource
  launchProjectEventAgent?: ForgeProjectEventAgentLaunchFactory
  recoverProjectEventRuns?: ForgeInboxOwnerServiceOptions['recoverProjectEventRuns']
  createProjectEventDispatchReader?: ForgeInboxOwnerServiceOptions['createProjectEventDispatchReader']
  http: Pick<MainHttpClient, 'fetch'>
  registerCleanup: (cleanup: () => void | Promise<void>) => void
}): Promise<void> {
  const { runtime } = input
  const store = input.store
  const receiverSettings =
    input.receiverSettings ?? (store ? projectEventReceiverSettingsForStore(store) : undefined)
  const decisionSource =
    input.decisionSource ??
    (store ? projectEventDecisionSourceForSettings(() => store.getSettings()) : undefined)
  input.registerCleanup(() => runtime.stopForgeInboxService())
  await startForgeInboxForHost({
    profileDirectory: input.profileDirectory,
    receiverSettings,
    ...(decisionSource ? { decisionSource } : {}),
    ...(input.launchProjectEventAgent
      ? { launchProjectEventAgent: input.launchProjectEventAgent }
      : {}),
    ...(input.createProjectEventDispatchReader
      ? { createProjectEventDispatchReader: input.createProjectEventDispatchReader }
      : {}),
    recoverProjectEventRuns:
      input.recoverProjectEventRuns ??
      forgeInboxProjectEventRunRecoveryForRuntime({
        ensureHost: () => runtime.ensureStructuredAgentSessionHost()
      }),
    resolveProjectBindingContext: forgeInboxProjectBindingContextForRuntime({
      requireStore: () => input.runtime.requireStore()
    }),
    http: input.http,
    networkReady: Promise.resolve(),
    attach: (service) => runtime.attachForgeInboxService(service),
    notify: (event) => runtime.dispatchMobileNotification(event)
  })
}
