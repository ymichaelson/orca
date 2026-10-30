import { glabExecFileAsync, type GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { glabRepoExecOptions } from './gitlab-project-ref-resolution'
import { extractExecError } from '../git/exec-error'
import { parseGlabApiResponse } from './glab-api-response'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

export type GitlabProjectApiFailureCode =
  | 'invalid-config'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'callback-blocked'
  | 'invalid-request'
  | 'network'
  | 'aborted'
  | 'bad-response'
  | 'ownership-conflict'
  | 'too-many-hooks'
  | 'event-configuration-rejected'
  | 'rate-limited'
  | 'unknown-outcome'

export class GitlabProjectApiError extends Error {
  constructor(readonly code: GitlabProjectApiFailureCode) {
    super(code)
    this.name = 'GitlabProjectApiError'
  }
}

export type GitlabProjectApiScope = {
  host: string
  projectId: string
  repoPath: string
  /** Set for a repository on a remote execution host; glab then runs there, not in a local cwd. */
  connectionId?: string | null
  exec?: (args: string[], options?: GlabExecOptions) => Promise<{ stdout: string; stderr: string }>
}

function httpStatusFromStdout(stdout: string): number | null {
  const match = /^HTTP\/\S+\s+(\d{3})/.exec(stdout)
  return match ? Number(match[1]) : null
}

function failureCodeForHttp(status: number, body: string): GitlabProjectApiFailureCode | null {
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
  if (status === 400 || status === 422) {
    return /blocked|local network/i.test(body) ? 'callback-blocked' : 'invalid-request'
  }
  if (status >= 500) {
    return 'network'
  }
  return null
}

function failureCode(error: unknown, signal?: AbortSignal): GitlabProjectApiFailureCode {
  if (signal?.aborted) {
    return 'aborted'
  }
  const { stderr, stdout } = extractExecError(error)
  const status = httpStatusFromStdout(stdout)
  if (status !== null) {
    const code = failureCodeForHttp(status, '')
    if (code) {
      return code
    }
  }
  if (/HTTP 401|not logged in|authentication required/i.test(stderr)) {
    return 'unauthorized'
  }
  if (/HTTP 403|forbidden|insufficient_scope/i.test(stderr)) {
    return 'forbidden'
  }
  if (/HTTP 404/i.test(stderr)) {
    return 'not-found'
  }
  if (/HTTP 429|rate limit/i.test(stderr)) {
    return 'rate-limited'
  }
  if (/URL is blocked|local network.*not allowed/i.test(stderr)) {
    return 'callback-blocked'
  }
  if (/HTTP 400|HTTP 422/i.test(stderr)) {
    return 'invalid-request'
  }
  return 'network'
}

/** `resource` is relative to `projects/<projectId>/`, so every caller owns its endpoint. */
export function createGitlabProjectApi(scope: GitlabProjectApiScope) {
  const exec = scope.exec ?? glabExecFileAsync
  return async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    resource: string,
    signal?: AbortSignal,
    body?: Readonly<Record<string, unknown>>
  ): Promise<unknown> => {
    if (signal?.aborted) {
      throw new GitlabProjectApiError('aborted')
    }
    let stdout: string
    try {
      const result = await exec(
        [
          'api',
          '-i',
          '--hostname',
          scope.host,
          '--method',
          method,
          `projects/${scope.projectId}/${resource}`,
          ...(body ? ['--input', '-'] : [])
        ],
        {
          ...glabRepoExecOptions(scope.repoPath, scope.connectionId),
          signal,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          idempotent: false,
          ...(body ? { stdin: JSON.stringify(body) } : {})
        }
      )
      stdout = result.stdout
    } catch (error) {
      throw new GitlabProjectApiError(failureCode(error, signal))
    }
    if (signal?.aborted) {
      throw new GitlabProjectApiError('aborted')
    }
    if (method === 'DELETE') {
      const status = httpStatusFromStdout(stdout)
      if (status !== null && status >= 400) {
        throw new GitlabProjectApiError(failureCodeForHttp(status, '') ?? 'bad-response')
      }
      return null
    }
    try {
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        throw new Error('too-large')
      }
      const { body: text } = parseGlabApiResponse(stdout)
      const status = httpStatusFromStdout(stdout)
      if (status !== null && status >= 400) {
        throw new GitlabProjectApiError(failureCodeForHttp(status, text) ?? 'bad-response')
      }
      assertJsonTextStructureWithinLimits(text, { structuralTokens: 40_000, nestingDepth: 16 })
      const result: unknown = JSON.parse(text)
      return result
    } catch (error) {
      if (error instanceof GitlabProjectApiError) {
        throw error
      }
      throw new GitlabProjectApiError('bad-response')
    }
  }
}
