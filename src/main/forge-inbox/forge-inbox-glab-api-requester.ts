import { stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { API_RESPONSE_JSON_LIMITS } from '../../shared/fetch-response-body'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { glabExecFileAsync, type GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { extractExecError, isMissingCommandBinaryError } from '../git/exec-error'
import { parseGlabApiResponse } from '../gitlab/gl-utils'
import {
  GITLAB_API_RESPONSE_MAX_BYTES,
  type GitlabApiErrorCode,
  type GitlabApiFailure,
  type GitlabApiRequester,
  type GitlabApiTextRequester,
  type GitlabJsonResponse,
  type GitlabTextResponse
} from './forge-inbox-gitlab-api-request'

export type GlabApiExec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type GlabApiRequesterConfig = {
  hostname: string
  /** glab runs as the host sees the checkout, so repository-scoped auth resolves the same way. */
  repoPath: string
  exec?: GlabApiExec
  signal?: AbortSignal
}

type RawResponse = { ok: true; body: string; headers: Record<string, string> }

const STATUS_LINE = /^HTTP\/\S+\s+(\d{3})/
const REPORTED_STATUS = /\bHTTP\s+(\d{3})\b/

function failureCodeFor(status: number): GitlabApiErrorCode {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 404) {
    return 'not-found'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  if (status === 409) {
    return 'conflict'
  }
  if (status === 405 || status === 422) {
    return 'rejected'
  }
  return status >= 500 ? 'network' : 'bad-response'
}

function statusLineOf(stdout: string): number | null {
  const match = STATUS_LINE.exec(stdout)
  return match ? Number(match[1]) : null
}

function reportedStatus(text: string): number | null {
  const match = REPORTED_STATUS.exec(text)
  return match ? Number(match[1]) : null
}

async function failureFromExecError(error: unknown, repoPath: string): Promise<GitlabApiFailure> {
  // Why: a missing binary is a local transport failure, not evidence about the host credential.
  if (isMissingCommandBinaryError(error)) {
    // Why: spawn reports a missing cwd with the same ENOENT shape as a missing binary.
    const cwdAbsent = await stat(repoPath).then(() => false, isDefinitiveAbsence)
    return { ok: false, code: cwdAbsent ? 'missing-checkout' : 'network' }
  }
  const { stderr, stdout } = extractExecError(error)
  const status = statusLineOf(stdout) ?? reportedStatus(stderr) ?? reportedStatus(stdout)
  return { ok: false, code: status === null ? 'network' : failureCodeFor(status) }
}

const ABSOLUTE_ROUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const RELATIVE_ROUTE = /^[A-Za-z0-9._~%!$&'()*+,;=:@/-]+$/

// Why: callers pass the complete route (e.g. `projects/3/merge_requests/7`); never add `projects/` again.
function routeOf(path: string, query: Record<string, string>): string | null {
  // Why: a scheme or `//` host would make glab fetch elsewhere and forward its token.
  if (path.startsWith('//') || ABSOLUTE_ROUTE.test(path)) {
    return null
  }
  const route = path.replace(/^\/+/, '')
  if (route === '' || !RELATIVE_ROUTE.test(route)) {
    return null
  }
  const search = new URLSearchParams(query).toString()
  return search ? `${route}?${search}` : route
}

async function request(
  config: GlabApiRequesterConfig,
  path: string,
  query: Record<string, string>
): Promise<RawResponse | GitlabApiFailure> {
  const route = routeOf(path, query)
  if (route === null) {
    return { ok: false, code: 'bad-response' }
  }
  let stdout: string
  try {
    const result = await (config.exec ?? glabExecFileAsync)(
      ['api', '-i', '--hostname', config.hostname, route],
      { cwd: config.repoPath, signal: config.signal }
    )
    stdout = result.stdout
  } catch (error) {
    return failureFromExecError(error, config.repoPath)
  }
  const status = statusLineOf(stdout)
  if (status !== null && status >= 400) {
    return { ok: false, code: failureCodeFor(status) }
  }
  const { body, headers } = parseGlabApiResponse(stdout)
  if (Buffer.byteLength(body, 'utf8') > GITLAB_API_RESPONSE_MAX_BYTES) {
    return { ok: false, code: 'bad-response' }
  }
  return { ok: true, body, headers }
}

export function createGlabApiRequester(config: GlabApiRequesterConfig): GitlabApiRequester {
  return {
    async get(path, query = {}): Promise<GitlabJsonResponse | GitlabApiFailure> {
      const response = await request(config, path, query)
      if (!response.ok) {
        return response
      }
      try {
        assertJsonTextStructureWithinLimits(response.body, API_RESPONSE_JSON_LIMITS)
        return {
          ok: true,
          json: JSON.parse(response.body),
          headers: new Headers(response.headers)
        }
      } catch {
        return { ok: false, code: 'bad-response' }
      }
    }
  }
}

export function createGlabApiTextRequester(config: GlabApiRequesterConfig): GitlabApiTextRequester {
  return {
    async getText(path, query = {}): Promise<GitlabTextResponse | GitlabApiFailure> {
      const response = await request(config, path, query)
      if (!response.ok) {
        return response
      }
      try {
        return { ok: true, text: response.body, headers: new Headers(response.headers) }
      } catch {
        return { ok: false, code: 'bad-response' }
      }
    }
  }
}
