import { startForgeInboxForHost } from '../forge-inbox/forge-inbox-host-startup'
import {
  forgeInboxAnalysisForRuntime,
  type ForgeInboxAnalysisRuntimeBinding
} from '../forge-inbox/forge-inbox-analysis-runtime'
import { forgeInboxDiscussForRuntime } from '../forge-inbox/forge-inbox-discuss-runtime'
import type { ForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { MainHttpClient } from '../network/http-client'

/** The stop is registered before the start is awaited, and the service is attached before it starts, so a shutdown mid-start still closes it. */
export async function startOrcadForgeInbox(input: {
  runtime: ForgeInboxAnalysisRuntimeBinding & {
    attachForgeInboxService(service: ForgeInboxOwnerService): void
    stopForgeInboxService(): Promise<void>
    dispatchMobileNotification(event: MobileNotificationDispatchEvent): void
  }
  profileDirectory: string
  http: Pick<MainHttpClient, 'fetch'>
  registerCleanup: (cleanup: () => void | Promise<void>) => void
}): Promise<void> {
  const { runtime } = input
  input.registerCleanup(() => runtime.stopForgeInboxService())
  await startForgeInboxForHost({
    profileDirectory: input.profileDirectory,
    http: input.http,
    networkReady: Promise.resolve(),
    attach: (service) => runtime.attachForgeInboxService(service),
    notify: (event) => runtime.dispatchMobileNotification(event),
    analyse: forgeInboxAnalysisForRuntime({
      runtime: {
        requireStore: () => runtime.requireStore(),
        resolveRuntimeFileTarget: (selector) => runtime.resolveRuntimeFileTarget(selector),
        ensureStructuredAgentSessionHost: () => runtime.ensureStructuredAgentSessionHost()
      },
      http: input.http
    }),
    discuss: forgeInboxDiscussForRuntime({
      ensureStructuredAgentSessionHost: () => runtime.ensureStructuredAgentSessionHost()
    })
  })
}
