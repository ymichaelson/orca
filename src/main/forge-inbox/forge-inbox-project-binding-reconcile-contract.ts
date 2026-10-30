import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import type { ProjectRef } from '../gitlab/gl-utils'
import type { ProjectEventBindingView } from '../../shared/forge-inbox-project-binding'

export type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type ProjectBindingProbe = (input: {
  bindingId: string
  callbackUrl: string
}) => Promise<{ ok: boolean; code?: string }>

export type ProjectBindingEvents = {
  enabledEvents: string[]
  unsupportedEvents: string[]
  rejectedEvents: string[]
}

export type BindingFailure = {
  ok: false
  binding: ProjectEventBindingView
  events: ProjectBindingEvents
  code?: string
  retryable?: boolean
}

export type EnsureProjectBindingResult =
  | { ok: true; binding: ProjectEventBindingView; events: ProjectBindingEvents }
  | { ok: false; binding: null; code: string; retryable: boolean }
  | BindingFailure

export type EnsureProjectBindingInput = {
  repoPath: string
  /** Durable repository id; required for the per-repo link and single-flight reconcile. */
  repoId?: string
  connectionId?: string | null
  explicitProjectRef?: ProjectRef | null
  /** Folder-only user text; parsed against the glab known hosts when no ref was passed. */
  explicitProjectRefText?: string | null
  receiverBaseUrl: string
  allowUnprotectedStorage?: boolean
  signal?: AbortSignal
  exec?: Exec
  probe: ProjectBindingProbe
}

export const NO_EVENTS: ProjectBindingEvents = {
  enabledEvents: [],
  unsupportedEvents: [],
  rejectedEvents: []
}

// Why: a conflicting clone must not persist its failure on the binding another repo relies on.
export const BINDING_LINK_CONFLICT: EnsureProjectBindingResult = {
  ok: false,
  binding: null,
  code: 'binding-conflict',
  retryable: false
}

export const RETRYABLE_HOOK_FAILURES = new Set([
  'unauthorized',
  'forbidden',
  'not-found',
  'callback-blocked',
  'invalid-request',
  'network',
  'aborted',
  'bad-response',
  'too-many-hooks',
  'rate-limited',
  'unknown-outcome'
])
