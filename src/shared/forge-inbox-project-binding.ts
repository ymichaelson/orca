import { z } from 'zod'

// One project binding ties an execution host's Orca project to a GitLab project. The
// connection moves through these phases while Orca configures the remote hook, and parks
// in 'failed' when it cannot. A binding is per (gitlab_host, gitlab_project_id): the same
// repo cannot be bound twice, whatever worktree hosts it.

export const PROJECT_EVENT_BINDING_PHASES = [
  'unconfigured',
  'checking',
  'registering',
  'verifying',
  'connected'
] as const
export type ProjectEventBindingPhase = (typeof PROJECT_EVENT_BINDING_PHASES)[number]

export const PROJECT_EVENT_BINDING_STATES = [...PROJECT_EVENT_BINDING_PHASES, 'failed'] as const
export type ProjectEventBindingState = (typeof PROJECT_EVENT_BINDING_STATES)[number]

export const PROJECT_EVENT_BINDING_FAILURE_PHASES = [
  'checking',
  'registering',
  'verifying'
] as const
export type ProjectEventBindingFailurePhase = (typeof PROJECT_EVENT_BINDING_FAILURE_PHASES)[number]

export type ProjectEventBindingFailure = {
  phase: ProjectEventBindingFailurePhase
  code: string
  failedAt: number
  retryable: boolean
}

export type ProjectEventBindingSecretProtection = 'sealed' | 'plaintext'

/** Public projection: the webhook secret is never present, only how it is protected. */
export type ProjectEventBindingView = {
  bindingId: string
  projectPath: string
  gitlabHost: string
  gitlabPath: string
  gitlabProjectId: number
  callbackUrl: string
  hookId: number | null
  state: ProjectEventBindingState
  failure: ProjectEventBindingFailure | null
  secretProtection: ProjectEventBindingSecretProtection | null
  /** Event flags this GitLab version refused; non-empty only with a failed verifying state. */
  rejectedEvents: string[]
  /** A rotation staged but not yet accepted by the remote; never exposed as the active secret. */
  rotationPending: boolean
  createdAt: number
  updatedAt: number
}

export const PROJECT_EVENT_BINDING_FAILURE_CODES = [
  'not-gitlab',
  'glab-unavailable',
  'unauthenticated',
  'forbidden',
  'project-not-found',
  'no-hook-permission',
  'network',
  'aborted',
  'bad-response',
  'invalid-config',
  'unauthorized',
  'not-found',
  'callback-blocked',
  'invalid-request',
  'ownership-conflict',
  'too-many-hooks',
  'event-configuration-rejected',
  'rate-limited',
  'unknown-outcome',
  'interrupted',
  'unprotected-storage',
  'secret-unavailable',
  'repo-not-found',
  'no-git-remote',
  'remote-host-repo',
  'receiver-not-configured',
  'binding-conflict',
  'cleanup-failed'
] as const
export type ProjectEventBindingFailureCode = (typeof PROJECT_EVENT_BINDING_FAILURE_CODES)[number]

const projectEventBindingIdSchema = z.uuid()

export function isProjectEventBindingId(value: string): boolean {
  return projectEventBindingIdSchema.safeParse(value).success
}
