import { isProjectEventBindingId } from '../../shared/forge-inbox-project-binding'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { getProjectBinding } from './forge-inbox-project-binding'
import {
  readProjectBindingPreviousSecret,
  readProjectBindingSecret
} from './forge-inbox-project-binding-secret'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import { tokensMatch } from './forge-inbox-webhook-request'

export type ProjectEventBindingAuth =
  | {
      ok: true
      bindingId: string
      /** Null when the binding exists but no repository is linked to it yet. */
      repoId: string | null
      policyGeneration: number | null
      policyEnabled: boolean
    }
  | { ok: false; status: number; code: string }

type Unauthorized = { ok: false; status: number; code: string }

const NOT_FOUND: Unauthorized = { ok: false, status: 404, code: 'not-found' }
const NOT_READY: Unauthorized = { ok: false, status: 409, code: 'binding-not-ready' }
const UNAVAILABLE: Unauthorized = { ok: false, status: 503, code: 'unavailable' }
const UNAUTHORIZED: Unauthorized = { ok: false, status: 401, code: 'unauthorized' }

/**
 * The callback path carries the binding id for routing; the binding own secret is what admits it,
 * so a secret from any other binding or from the retired instance flow cannot open this receiver.
 */
export function authorizeProjectEventBinding(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; token: string }
): ProjectEventBindingAuth {
  if (!isProjectEventBindingId(input.bindingId)) {
    return NOT_FOUND
  }
  let binding
  let secret
  try {
    binding = getProjectBinding(ctx, input.bindingId)
    if (!binding) {
      return NOT_FOUND
    }
    if (binding.state !== 'connected') {
      return NOT_READY
    }
    secret = readProjectBindingSecret(ctx, input.bindingId)?.secret ?? null
  } catch {
    return UNAVAILABLE
  }
  if (secret === null) {
    return UNAVAILABLE
  }
  if (!tokensMatch(input.token, secret) && !matchesRetiredSecret(ctx, input)) {
    return UNAUTHORIZED
  }
  const repoId = getProjectEventRepoLinkByBinding(ctx, input.bindingId)?.repoId ?? null
  const policy = repoId === null ? null : getProjectEventPolicy(ctx, repoId)
  return {
    ok: true,
    bindingId: input.bindingId,
    repoId,
    policyGeneration: policy?.generation ?? null,
    policyEnabled: policy?.enabled === true
  }
}

/** GitLab may still be delivering callbacks it signed with the secret replaced by a rotation. */
function matchesRetiredSecret(
  ctx: ForgeLedgerContext,
  input: { bindingId: string; token: string }
): boolean {
  try {
    const previous = readProjectBindingPreviousSecret(ctx, input.bindingId)?.secret ?? null
    return previous !== null && tokensMatch(input.token, previous)
  } catch {
    return false
  }
}
