import { join } from 'node:path'
import type { MainHttpClient } from '../network/http-client'
import { FORGE_INBOX_OWNER_NOT_RUNNING } from './forge-inbox-owner-errors'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import { createForgeNotificationDispatcher } from './forge-inbox-notification-dispatch'
import { forgeErrorLabel } from './forge-inbox-error-label'
import {
  createForgeInboxOwnerService,
  type ForgeAnalysisRunnerFactory,
  type ForgeInboxOwnerService,
  type ForgeInboxOwnerServiceOptions
} from './forge-inbox-owner-service'

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
  /** Without one, queued analyses stay queued: a host that cannot run a protected session must not fake it. */
  analyse?: ForgeAnalysisRunnerFactory
  /** Without one, Discuss is refused: a session this host cannot prove is never resumed elsewhere. */
  discuss?: NonNullable<ForgeInboxOwnerServiceOptions['discuss']>
}): Promise<ForgeInboxHostStartup> {
  const service = createForgeInboxOwnerService({
    dbPath: join(input.profileDirectory, FORGE_INBOX_LEDGER_FILE),
    http: input.http,
    networkReady: input.networkReady,
    notificationSinks: [createForgeNotificationDispatcher(input.notify)],
    ...(input.analyse ? { analyse: input.analyse } : {}),
    ...(input.discuss ? { discuss: input.discuss } : {})
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
