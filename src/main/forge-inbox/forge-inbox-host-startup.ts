import { join } from 'node:path'
import type { MainHttpClient } from '../network/http-client'
import { FORGE_INBOX_OWNER_NOT_RUNNING } from './forge-inbox-owner-errors'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import { createForgeNotificationDispatcher } from './forge-inbox-notification-dispatch'
import { forgeErrorLabel } from './forge-inbox-error-label'
import {
  projectEventDecisionForSource,
  type ProjectEventDecisionSource
} from './forge-inbox-decision-runtime'
import {
  createForgeInboxOwnerService,
  type ForgeInboxOwnerService,
  type ForgeInboxOwnerServiceOptions
} from './forge-inbox-owner-service'
import { createGlabDispatchConfirmationReaderFactory } from './forge-inbox-dispatch-confirmation-reader'
import { createForgeProjectEventContextObserver } from './forge-inbox-project-event-context-observer'

export const FORGE_INBOX_LEDGER_FILE = 'forge-inbox.db'

export type ForgeInboxHostStartup = { started: true } | { started: false; code: string }

/** A failed start is logged by code and leaves the host running with a final stopped service; it never picks another profile. */
export async function startForgeInboxForHost(input: {
  profileDirectory: string
  http: Pick<MainHttpClient, 'fetch'>
  networkReady: Promise<void>
  attach: (service: ForgeInboxOwnerService) => void
  /** The runtime's notification dispatch; Forge attention rides the same fan-out as every other lane. */
  notify: (event: MobileNotificationDispatchEvent) => void
  receiverSettings?: ForgeInboxOwnerServiceOptions['receiverSettings']
  secretStore?: ForgeInboxOwnerServiceOptions['secretStore']
  /** Without one, no background binding can resolve a repo, so none is attempted. */
  resolveProjectBindingContext?: ForgeInboxOwnerServiceOptions['resolveProjectBindingContext']
  /** Without one, binding deliveries stay pending until a host that can decide opens the ledger. */
  decisionSource?: ProjectEventDecisionSource
  /** Without one, dispatch_agent stays queued and is refused as dispatch-unavailable. */
  launchProjectEventAgent?: ForgeInboxOwnerServiceOptions['launchProjectEventAgent']
  /** Without one, a dead process's unverifiable dispatched runs keep their recorded verdict. */
  recoverProjectEventRuns?: ForgeInboxOwnerServiceOptions['recoverProjectEventRuns']
  /** Defaults to glab as the checkout sees it; tests inject a fake so no GitLab is contacted. */
  createProjectEventDispatchReader?: ForgeInboxOwnerServiceOptions['createProjectEventDispatchReader']
}): Promise<ForgeInboxHostStartup> {
  const service = createForgeInboxOwnerService({
    dbPath: join(input.profileDirectory, FORGE_INBOX_LEDGER_FILE),
    http: input.http,
    networkReady: input.networkReady,
    receiverSettings: input.receiverSettings,
    secretStore: input.secretStore,
    notificationSinks: [createForgeNotificationDispatcher(input.notify)],
    ...(input.decisionSource
      ? { decideProjectEvent: projectEventDecisionForSource(input.decisionSource, input.http) }
      : {}),
    observeProjectEventContext: (ledger) => createForgeProjectEventContextObserver(ledger),
    ...(input.launchProjectEventAgent
      ? { launchProjectEventAgent: input.launchProjectEventAgent }
      : {}),
    createProjectEventDispatchReader:
      input.createProjectEventDispatchReader ?? createGlabDispatchConfirmationReaderFactory(),
    ...(input.recoverProjectEventRuns
      ? { recoverProjectEventRuns: input.recoverProjectEventRuns }
      : {}),
    ...(input.resolveProjectBindingContext
      ? { resolveProjectBindingContext: input.resolveProjectBindingContext }
      : {})
  })
  try {
    // Attached before the start so a stop during the ledger-open and listener-bind window reaches it.
    input.attach(service)
    await service.start()
  } catch (error) {
    const code = forgeErrorLabel(error)
    if (code === FORGE_INBOX_OWNER_NOT_RUNNING) {
      console.warn('[forge-inbox] start skipped: shutting down')
    } else {
      console.error('[forge-inbox] start failed', code)
    }
    return { started: false, code }
  }
  return { started: true }
}
