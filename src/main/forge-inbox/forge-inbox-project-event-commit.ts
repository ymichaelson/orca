import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import type { ProjectEventHeaderGate } from './forge-inbox-project-event-headers'
import {
  legacyDigestDedupeKey,
  messageDedupeKey,
  parseWebhookBody
} from './forge-inbox-webhook-request'
import type { ProjectEventBindingAuth } from './forge-inbox-project-event-binding-auth'

type Admitted = Extract<ProjectEventHeaderGate, { ok: true }>
type Authorized = Extract<ProjectEventBindingAuth, { ok: true }>

export type BindingCommit = { status: number; code: string; wake: boolean } | { failed: true }

/** Re-checks the binding, then commits one delivery. A moved secret or binding never commits. */
export function commitProjectEventDelivery(
  ledger: ForgeInboxLedger,
  headers: Admitted,
  still: Authorized,
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
    const result = admitProjectEventDelivery(ledger.ledgerContext(), ledger.webhookQueueLimits(), {
      bindingId: headers.bindingId,
      projectPath: binding.gitlabPath,
      policyGeneration: still.policyGeneration,
      policyEnabled: still.policyEnabled,
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
