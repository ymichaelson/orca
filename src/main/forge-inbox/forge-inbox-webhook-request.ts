import { createHash, timingSafeEqual } from 'node:crypto'

const ROUTE = /^\/webhooks\/gitlab\/([a-z0-9][a-z0-9-]{0,62})$/
const IDENTITY = /^[\x21-\x7e]{1,256}$/
const LABEL = /^[\x20-\x7e]{1,128}$/

export type HeaderRead =
  | { state: 'absent' }
  | { state: 'duplicate' }
  | { state: 'invalid' }
  | { state: 'ok'; value: string }

/** Raw headers keep repeats that Node's merged `headers` map would hide. */
export function readSingleHeader(rawHeaders: string[], name: string): HeaderRead {
  let found: string | null = null
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) {
      if (found !== null) {
        return { state: 'duplicate' }
      }
      found = rawHeaders[i + 1].trim()
    }
  }
  return found === null ? { state: 'absent' } : { state: 'ok', value: found }
}

/** Returns the instance id for exactly `/webhooks/gitlab/<id>`; a query string never matches. */
export function parseWebhookRoute(url: string | undefined): string | null {
  return ROUTE.exec(url ?? '')?.[1] ?? null
}

export function isJsonContentType(rawHeaders: string[]): boolean {
  const header = readSingleHeader(rawHeaders, 'content-type')
  return header.state === 'ok' && /^application\/json\s*(;|$)/i.test(header.value)
}

/** Fixed-size digests keep timingSafeEqual from throwing on, or leaking, the supplied length. */
export function tokensMatch(supplied: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(supplied), digest(expected))
}

/** webhook-id and Idempotency-Key are aliases of one retry-stable identity, webhook-id first. */
export function readMessageId(rawHeaders: string[]): HeaderRead {
  for (const name of ['webhook-id', 'idempotency-key']) {
    const header = readSingleHeader(rawHeaders, name)
    if (header.state === 'ok' && !IDENTITY.test(header.value)) {
      return { state: 'invalid' }
    }
    if (header.state !== 'absent') {
      return header
    }
  }
  return { state: 'absent' }
}

/** Correlation ids are advisory, so an odd one is dropped instead of failing the delivery. */
export function readCorrelationId(rawHeaders: string[], name: string): string | null {
  const header = readSingleHeader(rawHeaders, name)
  return header.state === 'ok' && LABEL.test(header.value) ? header.value : null
}

export function readEventKind(rawHeaders: string[]): string | null {
  const header = readSingleHeader(rawHeaders, 'x-gitlab-event')
  return header.state === 'ok' && LABEL.test(header.value) ? header.value : null
}

export function messageDedupeKey(messageId: string): string {
  return `msg:${messageId}`
}

export function legacyDigestDedupeKey(projectId: string, eventKind: string, body: Buffer): string {
  const digest = createHash('sha256').update(body).digest('hex')
  return `digest:${projectId}:${eventKind}:${digest}`
}

function projectIdOf(value: unknown): string | null {
  const id = typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : value
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null
}

export type WebhookBody = { ok: true; projectId: string } | { ok: false }

/** Accepts only a UTF-8 JSON object whose own `project.id` / `project_id` agree on one safe id. */
export function parseWebhookBody(body: Buffer): WebhookBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body))
  } catch {
    return { ok: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false }
  }
  const claims: unknown[] = []
  if ('project_id' in parsed) {
    claims.push(parsed.project_id)
  }
  if ('project' in parsed && typeof parsed.project === 'object' && parsed.project !== null) {
    if ('id' in parsed.project) {
      claims.push(parsed.project.id)
    }
  }
  const ids = claims.map(projectIdOf)
  const [first] = ids
  if (first === undefined || first === null || ids.some((id) => id !== first)) {
    return { ok: false }
  }
  return { ok: true, projectId: first }
}

/** HTTP reply for each ledger admission rejection. */
export const WEBHOOK_REJECTIONS = {
  'stale-config': [503, 'config-changed'],
  'unknown-project': [422, 'project-not-configured'],
  'project-disabled': [422, 'project-disabled'],
  'queue-full': [503, 'queue-full'],
  'body-too-large': [413, 'body-too-large']
} as const
