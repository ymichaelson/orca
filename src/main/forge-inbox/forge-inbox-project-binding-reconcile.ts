import { randomBytes, randomUUID } from 'node:crypto'
import {
  resolveGitlabProjectIdentity,
  verifyGitlabHookPermission
} from '../gitlab/gitlab-project-identity'
import { createGitlabProjectHookClient } from '../gitlab/gitlab-project-hooks'
import { parseGitLabProjectRef } from '../gitlab/project-ref-parser'
import { getGlabKnownHosts } from '../gitlab/gl-utils'
import type { ProjectEventBindingFailurePhase } from '../../shared/forge-inbox-project-binding'
import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  BINDING_LINK_CONFLICT,
  NO_EVENTS,
  RETRYABLE_HOOK_FAILURES,
  type BindingFailure,
  type EnsureProjectBindingInput,
  type EnsureProjectBindingResult,
  type ProjectBindingEvents
} from './forge-inbox-project-binding-reconcile-contract'
import {
  getProjectBindingByGitlab,
  setProjectBindingProgress,
  upsertProjectBinding
} from './forge-inbox-project-binding'
import {
  ProjectBindingSecretUnavailableError,
  readProjectBindingPendingSecret,
  readProjectBindingSecret,
  setProjectBindingSecret
} from './forge-inbox-project-binding-secret'
import { settleStagedSecret } from './forge-inbox-project-binding-staged-secret'
import {
  hasProjectEventLinkConflict,
  linkProjectEventBinding
} from './forge-inbox-project-event-link'
import { resumeProjectEventDeliveriesForRepo } from './forge-inbox-project-event-receive'

export {
  removeProjectBinding,
  type RemoveProjectBindingResult
} from './forge-inbox-project-binding-remove'
export type {
  EnsureProjectBindingInput,
  EnsureProjectBindingResult,
  ProjectBindingEvents,
  ProjectBindingProbe
} from './forge-inbox-project-binding-reconcile-contract'

const HOOK_PATH = '/webhooks/gitlab/'

const retryableIdentityFailure = new Set([
  'glab-unavailable',
  'unauthenticated',
  'forbidden',
  'project-not-found',
  'no-hook-permission',
  'network',
  'aborted',
  'bad-response'
])

// One reconcile per (host, repo) at a time; a second worktree joins the first instead of racing it.
const inFlight = new WeakMap<object, Map<string, Promise<EnsureProjectBindingResult>>>()

function callbackUrlFor(receiverBaseUrl: string, bindingId: string): string {
  return `${receiverBaseUrl.replace(/\/+$/, '')}${HOOK_PATH}${bindingId}`
}

function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

function fail(
  ctx: ForgeLedgerContext,
  bindingId: string,
  phase: ProjectEventBindingFailurePhase,
  code: string,
  retryable: boolean,
  events: ProjectBindingEvents = NO_EVENTS
): BindingFailure {
  const binding = setProjectBindingProgress(ctx, bindingId, {
    state: 'failed',
    failure: { phase, code, retryable }
  })
  return { ok: false, binding, events, code, retryable }
}

function readExistingSecret(ctx: ForgeLedgerContext, bindingId: string): string | null {
  try {
    return readProjectBindingSecret(ctx, bindingId)?.secret ?? null
  } catch {
    return null
  }
}

function secretStorageFailure(
  stored: Extract<ReturnType<typeof setProjectBindingSecret>, { ok: false }>
): { code: string; retryable: boolean } {
  if (stored.reason === 'unprotected-storage') {
    return { code: 'unprotected-storage', retryable: true }
  }
  return { code: 'secret-unavailable', retryable: false }
}

export function ensureProjectBinding(
  ctx: ForgeLedgerContext,
  input: EnsureProjectBindingInput
): Promise<EnsureProjectBindingResult> {
  const { repoId } = input
  if (repoId === undefined) {
    return ensureProjectBindingOnce(ctx, input)
  }
  let pendingByRepo = inFlight.get(ctx.db)
  if (!pendingByRepo) {
    pendingByRepo = new Map()
    inFlight.set(ctx.db, pendingByRepo)
  }
  const key = `${ctx.hostId}\u0000${repoId}`
  const existing = pendingByRepo.get(key)
  if (existing) {
    return existing
  }
  let pending: Promise<EnsureProjectBindingResult>
  pending = ensureProjectBindingOnce(ctx, input).finally(() => {
    if (pendingByRepo.get(key) === pending) {
      pendingByRepo.delete(key)
    }
  })
  pendingByRepo.set(key, pending)
  return pending
}

async function ensureProjectBindingOnce(
  ctx: ForgeLedgerContext,
  input: EnsureProjectBindingInput
): Promise<EnsureProjectBindingResult> {
  const {
    repoPath,
    repoId,
    connectionId = null,
    explicitProjectRef,
    explicitProjectRefText,
    receiverBaseUrl,
    allowUnprotectedStorage,
    signal,
    exec,
    probe
  } = input

  let projectRef = explicitProjectRef
  if (projectRef === undefined && explicitProjectRefText) {
    projectRef = parseGitLabProjectRef(
      explicitProjectRefText,
      await getGlabKnownHosts(connectionId)
    )
    if (projectRef === null) {
      // Why reuse `not-gitlab`: unknown hosts and malformed text are exactly what it already means
      // to clients, and a new code would fall back to generic copy.
      return { ok: false, binding: null, code: 'not-gitlab', retryable: false }
    }
  }

  const identity = await resolveGitlabProjectIdentity({
    repoPath,
    connectionId,
    explicitProjectRef: projectRef,
    signal,
    exec
  })
  if (!identity.ok) {
    return {
      ok: false,
      binding: null,
      code: identity.code,
      retryable: retryableIdentityFailure.has(identity.code)
    }
  }
  const { host, path, projectId } = identity.identity

  const existing = getProjectBindingByGitlab(ctx, host, projectId)
  if (
    repoId !== undefined &&
    hasProjectEventLinkConflict(ctx, repoId, existing?.bindingId ?? null)
  ) {
    return BINDING_LINK_CONFLICT
  }
  const bindingId = existing?.bindingId ?? randomUUID()
  upsertProjectBinding(ctx, {
    bindingId,
    projectPath: repoPath,
    gitlabHost: host,
    gitlabPath: path,
    gitlabProjectId: projectId,
    callbackUrl: callbackUrlFor(receiverBaseUrl, bindingId)
  })

  if (repoId !== undefined) {
    const linked = linkProjectEventBinding(ctx, { repoId, bindingId, projectPath: repoPath })
    if (!linked.ok) {
      return BINDING_LINK_CONFLICT
    }
    resumeProjectEventDeliveriesForRepo(ctx, repoId)
  }

  setProjectBindingProgress(ctx, bindingId, {
    state: 'checking',
    hookId: existing?.hookId ?? null,
    rejectedEvents: []
  })

  const permission = await verifyGitlabHookPermission({
    repoPath,
    connectionId,
    host,
    projectId,
    signal,
    exec
  })
  if (!permission.ok) {
    return fail(
      ctx,
      bindingId,
      'checking',
      permission.code,
      retryableIdentityFailure.has(permission.code)
    )
  }

  // Why: a staged secret may already be live remotely, so reconcile applies it before promoting it.
  let staged: string | null
  try {
    staged = readProjectBindingPendingSecret(ctx, bindingId)
  } catch (error) {
    if (!(error instanceof ProjectBindingSecretUnavailableError)) {
      throw error
    }
    return fail(ctx, bindingId, 'registering', 'secret-unavailable', true)
  }
  let secret = staged ?? readExistingSecret(ctx, bindingId)
  if (secret === null) {
    const candidate = generateSecret()
    const stored = setProjectBindingSecret(ctx, {
      bindingId,
      secret: candidate,
      allowUnprotectedStorage
    })
    if (!stored.ok) {
      const failure = secretStorageFailure(stored)
      return fail(ctx, bindingId, 'registering', failure.code, failure.retryable)
    }
    secret = candidate
  }

  setProjectBindingProgress(ctx, bindingId, { state: 'registering' })

  const client = createGitlabProjectHookClient({
    host,
    projectId: String(projectId),
    repoPath,
    connectionId,
    exec
  })
  const registered = await client.ensure(
    {
      bindingId,
      callbackUrl: callbackUrlFor(receiverBaseUrl, bindingId),
      secret,
      hookId: existing?.hookId ?? undefined
    },
    signal
  )

  if (staged !== null) {
    settleStagedSecret(ctx, bindingId, registered.ok ? null : registered.code)
  }

  if (!registered.ok && registered.code !== 'event-configuration-rejected') {
    return fail(
      ctx,
      bindingId,
      'registering',
      registered.code,
      RETRYABLE_HOOK_FAILURES.has(registered.code)
    )
  }

  const rejectedEvents = registered.ok ? [] : registered.rejectedEvents
  setProjectBindingProgress(ctx, bindingId, {
    state: 'verifying',
    hookId: registered.hookId,
    rejectedEvents
  })

  const probed = await probe({
    bindingId,
    callbackUrl: callbackUrlFor(receiverBaseUrl, bindingId)
  })
  if (!probed.ok) {
    return fail(ctx, bindingId, 'verifying', probed.code ?? 'probe-failed', true)
  }

  if (!registered.ok) {
    // The hook stays registered so accepted events still deliver; the refused flags are explicit.
    return fail(ctx, bindingId, 'verifying', 'event-configuration-rejected', false, {
      enabledEvents: registered.enabledEvents,
      unsupportedEvents: registered.unsupportedEvents,
      rejectedEvents
    })
  }

  const binding = setProjectBindingProgress(ctx, bindingId, {
    state: 'connected',
    hookId: registered.hookId,
    rejectedEvents: []
  })
  return {
    ok: true,
    binding,
    events: {
      enabledEvents: registered.enabledEvents,
      unsupportedEvents: registered.unsupportedEvents,
      rejectedEvents: []
    }
  }
}
