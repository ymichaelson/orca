import { PROJECT_EVENT_RECEIVER_LISTENER_ERROR_CODES as LISTENER_ERROR_CODES } from '../../shared/project-event-receiver-listener-error-codes'
import {
  normalizeProjectEventReceiverSettings,
  receiverRequiresPlaintextAcknowledgement
} from '../../shared/project-event-receiver-settings'
import type { ProjectEventReceiverSettingsSource } from '../project-events/project-event-receiver-settings-source'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { ForgeWebhookIngress, type ForgeWebhookIngressOptions } from './forge-inbox-webhook-ingress'

export type ForgeOwnerListenerStatus = {
  enabled: boolean
  listening: boolean
  port: number | null
  error: string | null
}

type Target = { host: string; port: number }

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : LISTENER_ERROR_CODES.listenFailed
}

/** Keeps the bound socket equal to the persisted listener tuple; a bind failure never picks another port. */
export function createForgeOwnerListener(
  ledger: ForgeInboxLedger,
  options: ForgeWebhookIngressOptions,
  receiverSettings: ProjectEventReceiverSettingsSource | undefined
) {
  let ingress: ForgeWebhookIngress | null = null
  let bound: Target | null = null
  let enabled = false
  let error: string | null = null
  let stopped = false

  async function release(): Promise<void> {
    const old = ingress
    ingress = null
    bound = null
    await old?.stop()
  }

  return {
    /** Callers serialize this; it always reads the latest persisted tuple. */
    async reconcile(): Promise<void> {
      if (stopped) {
        return
      }
      const listener = normalizeProjectEventReceiverSettings(receiverSettings?.read())
      enabled = listener.enabled
      const blocked = receiverRequiresPlaintextAcknowledgement(listener)
      const desired =
        enabled && !blocked ? { host: listener.bindAddress, port: listener.port } : null
      const unchanged =
        desired !== null &&
        bound?.host === desired.host &&
        bound.port === desired.port &&
        ingress?.status().listening === true
      if (unchanged) {
        return
      }
      await release()
      if (stopped) {
        return
      }
      error = blocked ? LISTENER_ERROR_CODES.externalPlaintextNotAcknowledged : null
      if (desired === null) {
        return
      }
      const next = new ForgeWebhookIngress(ledger, options)
      try {
        await next.listen(desired)
      } catch (failure) {
        error = errorCode(failure)
        await next.stop()
        return
      }
      if (stopped) {
        await next.stop()
        return
      }
      ingress = next
      bound = desired
    },
    status(): ForgeOwnerListenerStatus {
      const live = ingress?.status()
      const listening = live?.listening === true
      return {
        enabled,
        listening,
        port: listening ? (live?.port ?? null) : null,
        error:
          error ??
          (enabled && bound !== null && !listening ? LISTENER_ERROR_CODES.listenerStopped : null)
      }
    },
    /** Final: a reconcile that is queued or mid-await after this can no longer bind or admit. */
    stop(): Promise<void> {
      stopped = true
      return release()
    }
  }
}
