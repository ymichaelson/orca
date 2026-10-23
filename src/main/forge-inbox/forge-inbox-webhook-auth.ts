import type http from 'node:http'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { FORGE_WEBHOOK_MAX_BODY_BYTES } from './forge-inbox-webhook-queue'
import {
  isJsonContentType,
  parseWebhookRoute,
  readCorrelationId,
  readEventKind,
  readMessageId,
  readSingleHeader,
  tokensMatch
} from './forge-inbox-webhook-request'

export type WebhookAuthResult =
  | { ok: false; status: number; code: string }
  | {
      ok: true
      instanceId: string
      /** Captured before the secret is read so a concurrent rotation always fails admission. */
      configRevision: number
      eventKind: string
      messageId: string | null
      correlation: { eventUuid: string | null; configUuid: string | null }
    }

/** Everything that can be decided from the headers alone, before any body byte is buffered. */
export function authenticateWebhookRequest(
  ledger: ForgeInboxLedger,
  req: http.IncomingMessage
): WebhookAuthResult {
  const instanceId = parseWebhookRoute(req.url)
  if (instanceId === null) {
    return { ok: false, status: 404, code: 'not-found' }
  }
  if (req.method !== 'POST') {
    return { ok: false, status: 405, code: 'method-not-allowed' }
  }
  if (!isJsonContentType(req.rawHeaders)) {
    return { ok: false, status: 415, code: 'unsupported-media-type' }
  }
  const declared = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared > FORGE_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: 'body-too-large' }
  }
  const token = readSingleHeader(req.rawHeaders, 'x-gitlab-token')
  if (token.state !== 'ok' || token.value === '') {
    return { ok: false, status: 401, code: 'unauthorized' }
  }
  let view: ReturnType<ForgeInboxLedger['getConfig']>
  let secret: string | null
  try {
    view = ledger.getConfig()
    secret = ledger.readSecret(instanceId, 'webhook')?.secret ?? null
  } catch {
    return { ok: false, status: 503, code: 'unavailable' }
  }
  const instance = view.config.instances.find((candidate) => candidate.id === instanceId)
  if (!instance) {
    return { ok: false, status: 404, code: 'not-found' }
  }
  if (secret === null) {
    return { ok: false, status: 503, code: 'unavailable' }
  }
  if (!tokensMatch(token.value, secret)) {
    return { ok: false, status: 401, code: 'unauthorized' }
  }
  const eventKind = readEventKind(req.rawHeaders)
  const messageId = readMessageId(req.rawHeaders)
  if (eventKind === null || messageId.state === 'duplicate' || messageId.state === 'invalid') {
    return { ok: false, status: 400, code: 'invalid-headers' }
  }
  if (messageId.state === 'absent' && !instance.allowLegacyPayloadDigestDedupe) {
    return { ok: false, status: 400, code: 'missing-delivery-id' }
  }
  const correlation = {
    eventUuid: readCorrelationId(req.rawHeaders, 'x-gitlab-event-uuid'),
    configUuid: readCorrelationId(req.rawHeaders, 'x-gitlab-webhook-uuid')
  }
  return {
    ok: true,
    instanceId,
    configRevision: view.configRevision,
    eventKind,
    messageId: messageId.state === 'ok' ? messageId.value : null,
    correlation
  }
}
