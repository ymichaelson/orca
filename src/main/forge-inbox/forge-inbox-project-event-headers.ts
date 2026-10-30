import type http from 'node:http'
import {
  isJsonContentType,
  parseWebhookRoute,
  readCorrelationId,
  readEventKind,
  readMessageId,
  readSingleHeader
} from './forge-inbox-webhook-request'
import { FORGE_WEBHOOK_MAX_BODY_BYTES } from './forge-inbox-webhook-queue'

export type ProjectEventHeaderGate =
  | { ok: false; status: number; code: string }
  | {
      ok: true
      bindingId: string
      token: string
      eventKind: string
      messageId: string | null
      correlation: { eventUuid: string | null; configUuid: string | null }
    }

/** Header checks only. The binding and its secret are decided after this returns. */
export function readProjectEventHeaders(req: http.IncomingMessage): ProjectEventHeaderGate {
  const bindingId = parseWebhookRoute(req.url)
  if (bindingId === null) {
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
  const eventKind = readEventKind(req.rawHeaders)
  const messageId = readMessageId(req.rawHeaders)
  if (eventKind === null || messageId.state === 'duplicate' || messageId.state === 'invalid') {
    return { ok: false, status: 400, code: 'invalid-headers' }
  }
  if (messageId.state === 'absent') {
    return { ok: false, status: 400, code: 'missing-delivery-id' }
  }
  return {
    ok: true,
    bindingId,
    token: token.value,
    eventKind,
    messageId: messageId.value,
    correlation: {
      eventUuid: readCorrelationId(req.rawHeaders, 'x-gitlab-event-uuid'),
      configUuid: readCorrelationId(req.rawHeaders, 'x-gitlab-webhook-uuid')
    }
  }
}
