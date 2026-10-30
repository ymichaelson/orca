import type { MainHttpClient } from '../network/http-client'
import {
  API_RESPONSE_JSON_LIMITS,
  FetchResponseBodyTooLargeError,
  readFetchResponseBytesWithinLimit,
  readFetchResponseTextWithinLimit
} from '../../shared/fetch-response-body'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

export const GITLAB_API_TIMEOUT_MS = 10_000
export const GITLAB_API_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
export const GITLAB_API_WRITE_MAX_BYTES = 256 * 1024
const RETRY_AFTER_MIN_MS = 1000
const RETRY_AFTER_MAX_MS = 300_000
const SENDABLE_TOKEN = /^[\x21-\x7e]+$/

export type GitlabApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'too-large'
  | 'request-too-large'
  | 'bad-response'
  | 'network'
  | 'missing-checkout'
  | 'stale-config'
  | 'no-credential'

export type GitlabApiFailure = { ok: false; code: GitlabApiErrorCode; retryAfterMs?: number }
export type GitlabApiResult<T> = { ok: true; data: T; complete: boolean } | GitlabApiFailure

export type GitlabApiRequester = {
  get(path: string, query?: Record<string, string>): Promise<GitlabJsonResponse | GitlabApiFailure>
}

/** Raw repository blobs are not JSON; reads stay on the same bounded, config-pinned path. */
export type GitlabApiTextRequester = {
  getText(
    path: string,
    query?: Record<string, string>
  ): Promise<GitlabTextResponse | GitlabApiFailure>
}

/** Writes carry their own credential; the read requester never gains this capability. */
export type GitlabApiWriteRequester = {
  post(path: string, body: unknown): Promise<GitlabJsonResponse | GitlabApiFailure>
}

export type GitlabJsonResponse = { ok: true; json: unknown; headers: Headers }
export type GitlabTextResponse = { ok: true; text: string; headers: Headers }

export type GitlabApiDeps = {
  http: Pick<MainHttpClient, 'fetch'>
  readToken: () => string | null
  readConfigRevision: () => number
  signal?: AbortSignal
}

export type GitlabApiScope = {
  baseUrl: string
  projectId: string
  expectedConfigRevision: number
}

/** Instance-level endpoints such as `/user` are not under a project path. */
export type GitlabApiInstanceScope = {
  baseUrl: string
  expectedConfigRevision: number
}

const STATUS_CODES: Record<number, GitlabApiErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found'
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null || !/^\d+$/.test(raw)) {
    return undefined
  }
  return Math.min(Math.max(Number(raw) * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
}

// Why: scope.baseUrl must already be canonical (no trailing slash); anything else fails closed as bad-response.
function projectUrl(
  scope: GitlabApiScope,
  path: string,
  query: Record<string, string>
): string | null {
  const prefix = `${scope.baseUrl}/api/v4/projects/${encodeURIComponent(scope.projectId)}`
  const search = new URLSearchParams(query).toString()
  const url = `${prefix}${path}${search ? `?${search}` : ''}`
  try {
    const parsed = new URL(url)
    const base = new URL(scope.baseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    return parsed.origin === base.origin &&
      parsed.pathname.startsWith(`${basePath}/api/v4/projects/`)
      ? url
      : null
  } catch {
    return null
  }
}

function instanceUrl(
  scope: GitlabApiInstanceScope,
  path: string,
  query: Record<string, string>
): string | null {
  const prefix = `${scope.baseUrl}/api/v4`
  const search = new URLSearchParams(query).toString()
  const url = `${prefix}${path}${search ? `?${search}` : ''}`
  try {
    const parsed = new URL(url)
    const base = new URL(scope.baseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    return parsed.origin === base.origin && parsed.pathname.startsWith(`${basePath}/api/v4/`)
      ? url
      : null
  } catch {
    return null
  }
}

function apiUrl(
  scope: GitlabApiScope | GitlabApiInstanceScope,
  path: string,
  query: Record<string, string>
): string | null {
  return 'projectId' in scope ? projectUrl(scope, path, query) : instanceUrl(scope, path, query)
}

type GitlabRequestSpec = {
  method: 'GET' | 'POST'
  path: string
  query: Record<string, string>
  body?: string
  /** A read may be discarded when config changed mid-flight; a write's response is proof it landed. */
  recheckStaleAfterResponse: boolean
  accept?: 'json' | 'text'
}

/**
 * Every call re-proves config freshness and builds its URL from config only, never from payloads.
 * An unsendable token would make fetch throw, which would otherwise look like a retryable failure.
 */
async function send(
  deps: GitlabApiDeps,
  scope: GitlabApiScope | GitlabApiInstanceScope,
  spec: GitlabRequestSpec
): Promise<GitlabTextResponse | GitlabApiFailure> {
  const stale = (): boolean => deps.readConfigRevision() !== scope.expectedConfigRevision
  if (stale()) {
    return { ok: false, code: 'stale-config' }
  }
  const token = deps.readToken()
  if (token === null || !SENDABLE_TOKEN.test(token)) {
    return { ok: false, code: 'no-credential' }
  }
  const url = apiUrl(scope, spec.path, spec.query)
  if (url === null) {
    return { ok: false, code: 'bad-response' }
  }
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': token,
    Accept: spec.accept === 'text' ? 'text/plain' : 'application/json'
  }
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  let response: Response
  try {
    response = await deps.http.fetch(url, {
      method: spec.method,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      signal: deps.signal
        ? AbortSignal.any([deps.signal, AbortSignal.timeout(GITLAB_API_TIMEOUT_MS)])
        : AbortSignal.timeout(GITLAB_API_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, code: 'network' }
  }
  if (spec.recheckStaleAfterResponse && stale()) {
    await cancelUnreadResponseBody(response)
    return { ok: false, code: 'stale-config' }
  }
  if (!response.ok) {
    const failure: GitlabApiFailure = {
      ok: false,
      code:
        response.status === 429 ? 'rate-limited' : (STATUS_CODES[response.status] ?? 'bad-response')
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response)
      if (wait !== undefined) {
        failure.retryAfterMs = wait
      }
    }
    await cancelUnreadResponseBody(response)
    return failure
  }
  let body: string | Uint8Array
  try {
    body =
      spec.accept === 'text'
        ? await readFetchResponseBytesWithinLimit(response, GITLAB_API_RESPONSE_MAX_BYTES)
        : await readFetchResponseTextWithinLimit(response, GITLAB_API_RESPONSE_MAX_BYTES)
  } catch (error) {
    // Why: a timeout, abort or reset mid-body is retryable; only an oversize body is not.
    return {
      ok: false,
      code: error instanceof FetchResponseBodyTooLargeError ? 'too-large' : 'network'
    }
  }
  if (spec.recheckStaleAfterResponse && stale()) {
    return { ok: false, code: 'stale-config' }
  }
  let text: string
  try {
    // Raw blobs must roundtrip byte for byte, including a leading UTF-8 BOM.
    text =
      typeof body === 'string'
        ? body
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    return { ok: false, code: 'bad-response' }
  }
  return { ok: true, text, headers: response.headers }
}

async function sendJson(
  deps: GitlabApiDeps,
  scope: GitlabApiScope | GitlabApiInstanceScope,
  spec: GitlabRequestSpec
): Promise<GitlabJsonResponse | GitlabApiFailure> {
  const response = await send(deps, scope, spec)
  if (!response.ok) {
    return response
  }
  try {
    assertJsonTextStructureWithinLimits(response.text, API_RESPONSE_JSON_LIMITS)
    return { ok: true, json: JSON.parse(response.text), headers: response.headers }
  } catch {
    return { ok: false, code: 'bad-response' }
  }
}

async function sendText(
  deps: GitlabApiDeps,
  scope: GitlabApiScope,
  spec: GitlabRequestSpec
): Promise<GitlabTextResponse | GitlabApiFailure> {
  return send(deps, scope, spec)
}

export function createGitlabApiRequester(
  deps: GitlabApiDeps,
  scope: GitlabApiScope
): GitlabApiRequester {
  return {
    get(path, query = {}) {
      return sendJson(deps, scope, { method: 'GET', path, query, recheckStaleAfterResponse: true })
    }
  }
}

export function createGitlabApiInstanceRequester(
  deps: GitlabApiDeps,
  scope: GitlabApiInstanceScope
): GitlabApiRequester {
  return {
    get(path, query = {}) {
      return sendJson(deps, scope, { method: 'GET', path, query, recheckStaleAfterResponse: true })
    }
  }
}

export function createGitlabApiTextRequester(
  deps: GitlabApiDeps,
  scope: GitlabApiScope
): GitlabApiTextRequester {
  return {
    getText(path, query = {}) {
      return sendText(deps, scope, {
        method: 'GET',
        path,
        query,
        recheckStaleAfterResponse: true,
        accept: 'text'
      })
    }
  }
}

export function createGitlabApiWriteRequester(
  deps: GitlabApiDeps,
  scope: GitlabApiScope
): GitlabApiWriteRequester {
  return {
    post(path, body) {
      const payload = JSON.stringify(body ?? null)
      if (Buffer.byteLength(payload, 'utf8') > GITLAB_API_WRITE_MAX_BYTES) {
        return Promise.resolve({ ok: false, code: 'request-too-large' })
      }
      return sendJson(deps, scope, {
        method: 'POST',
        path,
        query: {},
        body: payload,
        recheckStaleAfterResponse: false
      })
    }
  }
}
