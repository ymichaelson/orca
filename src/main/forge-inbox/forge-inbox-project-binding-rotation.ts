import { randomBytes } from 'node:crypto'
import type { ProjectEventBindingView } from '../../shared/forge-inbox-project-binding'
import type { GlabExecOptions } from '../git/command-runner/glab-exec-file'
import { createGitlabProjectHookClient } from '../gitlab/gitlab-project-hooks'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { getProjectBinding, setProjectBindingProgress } from './forge-inbox-project-binding'
import { RETRYABLE_HOOK_FAILURES } from './forge-inbox-project-binding-reconcile-contract'
import {
  clearProjectBindingSecretRotation,
  ProjectBindingSecretUnavailableError,
  promoteProjectBindingSecretRotation,
  readProjectBindingPendingSecret,
  readProjectBindingSecret,
  stageProjectBindingSecretRotation
} from './forge-inbox-project-binding-secret'

type Exec = (
  args: string[],
  options?: GlabExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type RotateProjectBindingSecretResult =
  | { ok: true; binding: ProjectEventBindingView }
  | { ok: false; binding: ProjectEventBindingView | null; code: string; retryable: boolean }

// A retained candidate may already be live remotely; only a fresh candidate can be discarded.
export async function rotateProjectBindingSecret(
  ctx: ForgeLedgerContext,
  input: {
    bindingId: string
    /** Trusted resolution of the repo's current Git root, never the binding's stored path. */
    repoPath: string
    connectionId?: string | null
    allowUnprotectedStorage?: boolean
    signal?: AbortSignal
    exec?: Exec
  }
): Promise<RotateProjectBindingSecretResult> {
  const binding = getProjectBinding(ctx, input.bindingId)
  if (!binding) {
    return { ok: false, binding: null, code: 'secret-unavailable', retryable: false }
  }
  let nextSecret: string | null
  try {
    nextSecret = readProjectBindingPendingSecret(ctx, binding.bindingId)
  } catch (error) {
    if (!(error instanceof ProjectBindingSecretUnavailableError)) {
      throw error
    }
    // Why: a failure unrelated to rotation stays the visible reason until a reconcile clears it.
    const failed =
      binding.state === 'failed' &&
      !(binding.failure?.phase === 'registering' && binding.failure.code === 'unknown-outcome')
        ? binding
        : setProjectBindingProgress(ctx, binding.bindingId, {
            state: 'failed',
            failure: { phase: 'registering', code: 'secret-unavailable', retryable: true }
          })
    return { ok: false, binding: failed, code: 'secret-unavailable', retryable: true }
  }
  let active: string | null = null
  try {
    active = readProjectBindingSecret(ctx, binding.bindingId)?.secret ?? null
  } catch {
    active = null
  }
  if (active === null) {
    return { ok: false, binding, code: 'secret-unavailable', retryable: false }
  }

  const retainedCandidate = nextSecret !== null
  if (nextSecret === null) {
    nextSecret = randomBytes(32).toString('base64url')
    const staged = stageProjectBindingSecretRotation(ctx, {
      bindingId: binding.bindingId,
      secret: nextSecret,
      ...(input.allowUnprotectedStorage === undefined
        ? {}
        : { allowUnprotectedStorage: input.allowUnprotectedStorage })
    })
    if (!staged.ok) {
      return {
        ok: false,
        binding,
        code:
          staged.reason === 'unprotected-storage' ? 'unprotected-storage' : 'secret-unavailable',
        retryable: staged.reason === 'unprotected-storage'
      }
    }
  }

  const client = createGitlabProjectHookClient({
    host: binding.gitlabHost,
    projectId: String(binding.gitlabProjectId),
    repoPath: input.repoPath,
    connectionId: input.connectionId,
    exec: input.exec
  })
  const registered = await client.ensure(
    {
      bindingId: binding.bindingId,
      callbackUrl: binding.callbackUrl,
      secret: nextSecret,
      hookId: binding.hookId ?? undefined
    },
    input.signal
  )

  if (registered.ok) {
    promoteProjectBindingSecretRotation(ctx, binding.bindingId)
    // A successful secret write cannot establish callback reachability; the owner reconciles it.
    const promoted = getProjectBinding(ctx, binding.bindingId)
    if (!promoted) {
      throw new Error('a rotated project binding should still exist')
    }
    return { ok: true, binding: promoted }
  }

  if (registered.code === 'event-configuration-rejected') {
    // The hook now authenticates with the new secret, so promote it and report the refused flags.
    promoteProjectBindingSecretRotation(ctx, binding.bindingId)
    const failed = setProjectBindingProgress(ctx, binding.bindingId, {
      state: 'failed',
      hookId: registered.hookId,
      failure: { phase: 'verifying', code: registered.code, retryable: false },
      rejectedEvents: registered.rejectedEvents
    })
    return { ok: false, binding: failed, code: registered.code, retryable: false }
  }

  if (registered.code === 'unknown-outcome') {
    const uncertain =
      binding.state === 'failed'
        ? getProjectBinding(ctx, binding.bindingId)
        : setProjectBindingProgress(ctx, binding.bindingId, {
            state: 'failed',
            failure: { phase: 'registering', code: registered.code, retryable: true }
          })
    return { ok: false, binding: uncertain, code: registered.code, retryable: true }
  }

  if (!retainedCandidate) {
    clearProjectBindingSecretRotation(ctx, binding.bindingId)
  }
  const current = getProjectBinding(ctx, binding.bindingId)
  if (!current) {
    throw new Error('a project binding should survive a failed rotation')
  }
  return {
    ok: false,
    binding: current,
    code: registered.code,
    retryable: RETRYABLE_HOOK_FAILURES.has(registered.code)
  }
}
