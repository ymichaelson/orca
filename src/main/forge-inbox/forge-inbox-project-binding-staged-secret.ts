import type { ForgeLedgerContext } from './forge-inbox-context'
import { promoteProjectBindingSecretRotation } from './forge-inbox-project-binding-secret'

/**
 * Applies the remote's answer to a staged secret from an earlier attempt: a landed write promotes
 * it. Any other outcome keeps it, because no later failure proves the earlier write never applied.
 */
export function settleStagedSecret(
  ctx: ForgeLedgerContext,
  bindingId: string,
  failureCode: string | null
): void {
  if (failureCode === null || failureCode === 'event-configuration-rejected') {
    promoteProjectBindingSecretRotation(ctx, bindingId)
  }
}
