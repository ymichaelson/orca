import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  admitForgeWebhookDelivery,
  getForgeWebhookQueueStatus,
  listForgeWebhookDeliveries,
  type ForgeWebhookAdmission,
  type ForgeWebhookQueueLimits
} from './forge-inbox-webhook-queue'
import {
  claimNextForgeWebhookDelivery,
  getForgeWebhookWorkSchedule,
  markForgeWebhookDeliveryDone,
  markForgeWebhookDeliveryFailed,
  markForgeWebhookDeliveryNeedsAuth,
  pruneFinishedForgeWebhookDeliveries,
  requeueForgeWebhookNeedsAuth
} from './forge-inbox-webhook-delivery-state'

/** Webhook queue and delivery methods, composed onto the ledger instance with its own limits. */
export function createForgeWebhookLedgerMethods(
  ctx: ForgeLedgerContext,
  limits: ForgeWebhookQueueLimits
) {
  return {
    webhookQueueLimits: () => limits,
    admitWebhookDelivery: (input: ForgeWebhookAdmission) =>
      admitForgeWebhookDelivery(ctx, limits, input),
    getWebhookQueueStatus: () => getForgeWebhookQueueStatus(ctx, limits),
    claimNextWebhookDelivery: (nowMs: number) => claimNextForgeWebhookDelivery(ctx, nowMs),
    getWebhookWorkSchedule: () => getForgeWebhookWorkSchedule(ctx),
    markWebhookDeliveryDone: (id: number) => markForgeWebhookDeliveryDone(ctx, id),
    markWebhookDeliveryFailed: (
      id: number,
      failure: Parameters<typeof markForgeWebhookDeliveryFailed>[2]
    ) => markForgeWebhookDeliveryFailed(ctx, id, failure),
    markWebhookDeliveryNeedsAuth: (id: number) => markForgeWebhookDeliveryNeedsAuth(ctx, id),
    requeueNeedsAuthWebhookDeliveries: (instanceId: string) =>
      requeueForgeWebhookNeedsAuth(ctx, instanceId),
    pruneFinishedWebhookDeliveries: (
      query: Parameters<typeof pruneFinishedForgeWebhookDeliveries>[1]
    ) => pruneFinishedForgeWebhookDeliveries(ctx, query),
    listWebhookDeliveries: (query: Parameters<typeof listForgeWebhookDeliveries>[1]) =>
      listForgeWebhookDeliveries(ctx, query)
  }
}

export type ForgeWebhookLedgerMethods = ReturnType<typeof createForgeWebhookLedgerMethods>
