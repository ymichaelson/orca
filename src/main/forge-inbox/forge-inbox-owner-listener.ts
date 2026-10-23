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
    : 'listen-failed'
}

/** Keeps the bound socket equal to the persisted listener tuple; a bind failure never picks another port. */
export function createForgeOwnerListener(
  ledger: ForgeInboxLedger,
  options: ForgeWebhookIngressOptions
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
      const { listener } = ledger.getConfig().config
      enabled = listener.enabled
      const desired = enabled ? { host: listener.bindAddress, port: listener.port } : null
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
      error = null
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
        error: error ?? (enabled && bound !== null && !listening ? 'listener-stopped' : null)
      }
    },
    /** Final: a reconcile that is queued or mid-await after this can no longer bind or admit. */
    stop(): Promise<void> {
      stopped = true
      return release()
    }
  }
}
