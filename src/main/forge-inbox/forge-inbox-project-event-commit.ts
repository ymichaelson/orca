import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { projectEventDeliveryAdmission } from './forge-inbox-project-event-delivery-admission'
import type { ProjectEventHeaderGate } from './forge-inbox-project-event-headers'
import {
  legacyDigestDedupeKey,
  messageDedupeKey,
  parseWebhookBody
} from './forge-inbox-webhook-request'

type Admitted = Extract<ProjectEventHeaderGate, { ok: true }>

export type BindingCommit = { status: number; code: string; wake: boolean } | { failed: true }

/** Commits one admitted delivery; a binding that moved after its second check never reaches here. */
export function commitProjectEventDelivery(
  ledger: ForgeInboxLedger,
  headers: Admitted,
  body: Buffer
): BindingCommit {
  const parsed = parseWebhookBody(body)
  if (!parsed.ok) {
    return { status: 400, code: 'invalid-body', wake: false }
  }
  const binding = ledger.getProjectBinding(headers.bindingId)
  if (!binding || String(binding.gitlabProjectId) !== parsed.projectId) {
    return { status: 422, code: 'project-not-configured', wake: false }
  }
  const dedupeKey =
    headers.messageId === null
      ? legacyDigestDedupeKey(parsed.projectId, headers.eventKind, body)
      : messageDedupeKey(headers.messageId)
  try {
    const ctx = ledger.ledgerContext()
    const result = admitProjectEventDelivery(ctx, ledger.webhookQueueLimits(), {
      // A project-level event is decided without a policy; only one merge request, issue or note waits.
      ...projectEventDeliveryAdmission(ctx, { bindingId: headers.bindingId, body }),
      eventKind: headers.eventKind,
      dedupeKey,
      correlation: headers.correlation,
      body
    })
    if (!result.ok) {
      const status = result.reason === 'body-too-large' ? 413 : 503
      return { status, code: result.reason, wake: false }
    }
    const code = result.duplicate ? 'duplicate' : result.state === 'parked' ? 'parked' : 'queued'
    return { status: 202, code, wake: !result.duplicate && result.state === 'pending' }
  } catch (error) {
    console.warn('[forge-inbox] webhook admission failed', forgeErrorLabel(error))
    return { failed: true }
  }
}
