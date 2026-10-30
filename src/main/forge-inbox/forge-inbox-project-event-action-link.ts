import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { cancelSupersededAction, finishDelivery } from './forge-inbox-project-event-action-settle'
import type {
  ProjectEventActionClaim,
  ProjectEventActionItemLinkResult
} from './forge-inbox-project-event-action-types'
import { ingestProjectEventDeliveryItem } from './forge-inbox-project-event-delivery-item'
import type { ProjectEventSubjectRefusal } from './forge-inbox-project-event-subject'
import { rowNumber } from './forge-inbox-rows'

export function linkProjectEventDecisionItem(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim
): ProjectEventActionItemLinkResult {
  return runForgeTransaction(ctx.db, (): ProjectEventActionItemLinkResult => {
    const held = ctx.db
      .prepare(`SELECT superseded FROM project_event_decisions WHERE id = ? AND host_id = ?
      AND action_token = ? AND action_state = 'processing'`)
      .get(claim.decisionId, ctx.hostId, claim.token)
    if (!held) {
      return { ok: false, reason: 'not-found' }
    }
    if (rowNumber(held, 'superseded') !== 0) {
      cancelSupersededAction(ctx, claim.decisionId)
      return { ok: false, reason: 'not-found' }
    }
    const refuse = (reason: ProjectEventSubjectRefusal | 'dispatch-unverifiable') => {
      const blocked = ctx.db
        .prepare(`UPDATE project_event_decisions SET action_state = 'blocked',
        last_error_code = ?, action_token = NULL, action_finished_at = ? WHERE id = ? AND host_id = ?
        AND action_token = ? AND action_state = 'processing' AND superseded = 0`)
        .run(reason, ctx.now(), claim.decisionId, ctx.hostId, claim.token)
      if (blocked.changes === 1) {
        finishDelivery(ctx, claim.deliveryId, 'failed', reason)
      }
      return { ok: false as const, reason }
    }
    if (claim.action === 'dispatch_agent') {
      const delivery = ctx.db
        .prepare(
          'SELECT length(body) AS bytes FROM webhook_deliveries WHERE id = ? AND host_id = ?'
        )
        .get(claim.deliveryId, ctx.hostId)
      if (delivery && rowNumber(delivery, 'bytes') === 0) {
        return refuse('dispatch-unverifiable')
      }
    }
    const linked = ingestProjectEventDeliveryItem(ctx, {
      deliveryId: claim.deliveryId,
      bindingId: claim.bindingId,
      notify: claim.action === 'notify'
    })
    if (!linked.ok) {
      return linked.reason === 'not-found'
        ? { ok: false, reason: 'not-found' }
        : refuse(linked.reason)
    }
    ctx.db
      .prepare('UPDATE project_event_decisions SET item_id = ? WHERE id = ?')
      .run(linked.itemId, claim.decisionId)
    return {
      ok: true,
      itemId: linked.itemId,
      subject: linked.subject,
      facts: linked.facts,
      ...(claim.action === 'notify' ? { notificationCategory: linked.notificationCategory } : {})
    }
  })
}
