import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'

/** A recovery failure never fails startup: the runs simply keep their interrupted verdict. */
export async function recoverRunsOnOpen(
  options: Pick<
    ForgeInboxOwnerServiceOptions,
    'recoverProjectEventRuns' | 'launchProjectEventAgent'
  >,
  ledger: ForgeInboxLedger
): Promise<void> {
  const recover = options.recoverProjectEventRuns
  if (!recover) {
    return
  }
  try {
    await recover(ledger)
  } catch (error) {
    console.warn('[forge-inbox] project event run recovery failed', forgeErrorLabel(error))
  }
}
