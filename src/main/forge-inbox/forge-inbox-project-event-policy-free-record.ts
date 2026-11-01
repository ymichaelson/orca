import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { ingestProjectEventDeliveryItem } from './forge-inbox-project-event-delivery-item'
import {
  askAboutMissingProjectEventPolicy,
  projectEventPolicyMissing
} from './forge-inbox-project-event-policy-notice'
import { finishForgeWebhookDelivery } from './forge-inbox-webhook-delivery-state'

/**
 * A project-level event a repository without a policy kept: it opens its own item and asks to turn
 * the policy on. A decision, let alone an agent, still needs the policy.
 */
export function recordProjectEventWithoutPolicy(
  ctx: ForgeLedgerContext,
  input: { deliveryId: number; bindingId: string }
): void {
  runForgeTransaction(ctx.db, () => {
    const missing = projectEventPolicyMissing(ctx, input.bindingId)
    const linked = ingestProjectEventDeliveryItem(ctx, {
      deliveryId: input.deliveryId,
      bindingId: input.bindingId,
      notify: false,
      only: 'project'
    })
    if (!linked.ok) {
      ctx.db
        .prepare(`UPDATE webhook_deliveries SET decision_state = 'decided',
          decision_token = NULL, next_attempt_at = NULL WHERE id = ? AND host_id = ?`)
        .run(input.deliveryId, ctx.hostId)
      // The stored event can never be decided, so it must not keep its queue slot or payload.
      finishForgeWebhookDelivery(
        ctx,
        input.deliveryId,
        'failed',
        linked.reason === 'not-found' ? 'invalid-input' : linked.reason
      )
      return
    }
    if (missing) {
      askAboutMissingProjectEventPolicy(ctx, linked.itemId, missing)
    }
    ctx.db
      .prepare(`UPDATE webhook_deliveries SET decision_state = 'decided', decision_token = NULL,
        next_attempt_at = NULL, parked_reason = 'recorded' WHERE id = ? AND host_id = ?`)
      .run(input.deliveryId, ctx.hostId)
  })
}
