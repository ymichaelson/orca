import type { GlabApiExec } from './forge-inbox-glab-api-requester'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeProjectEventContextObserver } from './forge-inbox-owner-service-options'
import { observeProjectEventBindingHead } from './forge-inbox-project-event-observation'

/** The host's fetch_context reader: one bounded glab snapshot per action, cancelled by the drain. */
export function createForgeProjectEventContextObserver(
  ledger: ForgeInboxLedger,
  exec?: GlabApiExec
): ForgeProjectEventContextObserver {
  return (claim, signal) =>
    observeProjectEventBindingHead(ledger.ledgerContext(), claim, {
      ...(exec === undefined ? {} : { exec }),
      ...(signal === undefined ? {} : { signal })
    })
}
