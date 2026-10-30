import type { GitLabViewer } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { glabExecFileAsync } from '../git/command-runner/glab-exec-file'
import { extractExecError, isMissingCommandBinaryError } from '../git/exec-error'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { parseGlabApiResponse } from './glab-api-response'
import {
  acquire,
  getGlabKnownHosts,
  glabRepoExecOptions,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

export type GitlabProjectIdentityFailureCode =
  | 'not-gitlab'
  | 'glab-unavailable'
  | 'unauthenticated'
  | 'forbidden'
  | 'project-not-found'
  | 'no-hook-permission'
  | 'network'
  | 'aborted'
  | 'bad-response'

export type GitlabProjectIdentity = {
  host: string
  path: string
  projectId: number
  viewer: GitLabViewer
}

export type GitlabProjectIdentityResult =
  | { ok: true; identity: GitlabProjectIdentity }
  | { ok: false; code: GitlabProjectIdentityFailureCode }

export type GitlabHookPermissionResult =
  | { ok: true }
  | { ok: false; code: GitlabProjectIdentityFailureCode }

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

type GitlabProjectAccessContext = {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  signal?: AbortSignal
  exec?: Exec
}

class GitlabProjectIdentityError extends Error {
  constructor(readonly code: GitlabProjectIdentityFailureCode) {
    super(code)
    this.name = 'GitlabProjectIdentityError'
  }
}

function httpStatusFromStdout(stdout: string): number | null {
  const match = /^HTTP\/\S+\s+(\d{3})/.exec(stdout)
  return match ? Number(match[1]) : null
}

function failureCodeForHttp(status: number): GitlabProjectIdentityFailureCode | null {
  if (status === 401) {
    return 'unauthenticated'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 404) {
    return 'project-not-found'
  }
  if (status >= 500) {
    return 'network'
  }
  return null
}

function failureCodeFromExecError(
  error: unknown,
  signal?: AbortSignal
): GitlabProjectIdentityFailureCode {
  if (signal?.aborted) {
    return 'aborted'
  }
  const { stderr, stdout } = extractExecError(error)
  const status = httpStatusFromStdout(stdout)
  if (status !== null) {
    const code = failureCodeForHttp(status)
    if (code) {
      return code
    }
  }
  if (isMissingCommandBinaryError(error) || /ENOENT|command not found|spawn glab/i.test(stderr)) {
    return 'glab-unavailable'
  }
  if (/HTTP 401|not logged in|authentication required/i.test(stderr)) {
    return 'unauthenticated'
  }
  if (/HTTP 403|forbidden|insufficient_scope/i.test(stderr)) {
    return 'forbidden'
  }
  if (/HTTP 404/i.test(stderr)) {
    return 'project-not-found'
  }
  return 'network'
}

// Why: glab `api -i` exits 0 on HTTP error envelopes and prints the status line
// to stdout, so error classification reads the status from stdout — not stderr.
async function apiGet(
  exec: Exec,
  endpointArgs: string[],
  context: {
    repoPath: string
    connectionId?: string | null
    localGitOptions: LocalGitExecOptions
  },
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) {
    throw new GitlabProjectIdentityError('aborted')
  }
  try {
    const { stdout } = await exec(['api', '-i', ...endpointArgs], {
      ...glabRepoExecOptions(context.repoPath, context.connectionId, context.localGitOptions),
      signal
    })
    const status = httpStatusFromStdout(stdout)
    if (status !== null && status >= 400) {
      throw new GitlabProjectIdentityError(failureCodeForHttp(status) ?? 'bad-response')
    }
    const { body } = parseGlabApiResponse(stdout)
    assertJsonTextStructureWithinLimits(body, { structuralTokens: 40_000, nestingDepth: 16 })
    return JSON.parse(body)
  } catch (error) {
    if (error instanceof GitlabProjectIdentityError) {
      throw error
    }
    throw new GitlabProjectIdentityError(failureCodeFromExecError(error, signal))
  }
}

function projectIdFrom(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const id = 'id' in raw ? raw.id : undefined
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

function viewerFrom(raw: unknown): GitLabViewer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const username = 'username' in raw ? raw.username : undefined
  const email = 'email' in raw ? raw.email : undefined
  if (typeof username !== 'string' || !username.trim()) {
    return null
  }
  return {
    username: username.trim(),
    email: typeof email === 'string' ? email.trim() || null : null
  }
}

function codeFromError(error: unknown, signal?: AbortSignal): GitlabProjectIdentityFailureCode {
  return error instanceof GitlabProjectIdentityError
    ? error.code
    : failureCodeFromExecError(error, signal)
}

export async function resolveGitlabProjectIdentity(
  input: GitlabProjectAccessContext & {
    explicitProjectRef?: ProjectRef | null
    preference?: IssueSourcePreference
    resolveProjectRef?: () => Promise<ProjectRef | null>
  }
): Promise<GitlabProjectIdentityResult> {
  const {
    repoPath,
    connectionId = null,
    localGitOptions = {},
    explicitProjectRef,
    preference,
    signal,
    exec = glabExecFileAsync,
    resolveProjectRef
  } = input

  const projectRef =
    explicitProjectRef !== undefined
      ? explicitProjectRef
      : resolveProjectRef
        ? await resolveProjectRef()
        : (
            await resolveIssueSource(
              repoPath,
              preference,
              await getGlabKnownHosts(connectionId, localGitOptions),
              connectionId,
              localGitOptions
            )
          ).source

  if (!projectRef) {
    return { ok: false, code: 'not-gitlab' }
  }

  const context = { repoPath, connectionId, localGitOptions }
  const hostArgs = ['--hostname', projectRef.host]
  await acquire()
  try {
    const project = await apiGet(
      exec,
      [...hostArgs, `projects/${encodedProject(projectRef.path)}`],
      context,
      signal
    )
    const projectId = projectIdFrom(project)
    if (projectId === null) {
      return { ok: false, code: 'bad-response' }
    }
    const viewer = await apiGet(exec, [...hostArgs, 'user'], context, signal)
    const currentViewer = viewerFrom(viewer)
    if (currentViewer === null) {
      return { ok: false, code: 'bad-response' }
    }
    return {
      ok: true,
      identity: {
        host: projectRef.host,
        path: projectRef.path,
        projectId,
        viewer: currentViewer
      }
    }
  } catch (error) {
    return { ok: false, code: codeFromError(error, signal) }
  } finally {
    release()
  }
}

export async function verifyGitlabHookPermission(
  input: GitlabProjectAccessContext & { host: string; projectId: number }
): Promise<GitlabHookPermissionResult> {
  const {
    repoPath,
    connectionId = null,
    localGitOptions = {},
    host,
    projectId,
    signal,
    exec = glabExecFileAsync
  } = input
  await acquire()
  try {
    await apiGet(
      exec,
      ['--hostname', host, `projects/${projectId}/hooks?per_page=1`],
      { repoPath, connectionId, localGitOptions },
      signal
    )
    return { ok: true }
  } catch (error) {
    const code = codeFromError(error, signal)
    return { ok: false, code: code === 'forbidden' ? 'no-hook-permission' : code }
  } finally {
    release()
  }
}
