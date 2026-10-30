import { recoverInterruptedProjectEventActions } from './forge-inbox-project-event-action'
import { recoverInterruptedProjectEventDecisions } from './forge-inbox-project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { markInterruptedForgePatchRequestsUnverifiable } from './forge-inbox-patch-requests'
import { markInterruptedProjectBindingsFailed } from './forge-inbox-project-binding'
import { markInterruptedForgeReceiptsUnknown } from './forge-inbox-proposals'
import { markInterruptedForgeRunsUnverifiable } from './forge-inbox-runs'

/** Restart recovery: no claim written by a dead process may still look in progress to a retry. */
export function recoverInterruptedForgeWork(ctx: ForgeLedgerContext): void {
  markInterruptedForgeReceiptsUnknown(ctx)
  markInterruptedForgeRunsUnverifiable(ctx)
  markInterruptedForgePatchRequestsUnverifiable(ctx)
  markInterruptedProjectBindingsFailed(ctx)
  recoverInterruptedProjectEventDecisions(ctx)
  recoverInterruptedProjectEventActions(ctx)
}
