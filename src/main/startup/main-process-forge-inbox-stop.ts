import { settleWithinMs } from '../quit-teardown-deadline'
import { forgeErrorLabel } from '../forge-inbox/forge-inbox-error-label'
import { mainProcessState as state } from './main-process-state'

// Why capped: a hung listener close must never hold the profile admission release or the quit.
export const FORGE_INBOX_STOP_DEADLINE_MS = 3_000

/** Never rejects; a failure or a hit cap is logged by code only. */
export async function stopMainProcessForgeInbox(): Promise<void> {
  const stopping = state.runtime?.stopForgeInboxService()
  if (!stopping) {
    return
  }
  const settled = await settleWithinMs(stopping, FORGE_INBOX_STOP_DEADLINE_MS)
  if (settled.outcome === 'timed-out') {
    console.error('[forge-inbox] stop timed out')
  } else if (settled.outcome === 'failed') {
    console.error('[forge-inbox] stop failed', forgeErrorLabel(settled.error))
  }
}
