import type { ForgePage, ForgeInstanceScope } from '../../shared/forge-inbox-types'
import { readDispatchConfirmationViews } from './forge-inbox-dispatch-confirmation-view'
import { readRunCancellationViews } from './forge-inbox-project-event-run-cancel-state'
import { readRunDispatchFacts } from './forge-inbox-run-dispatch-view'
import { countUnreadForgeItems } from './forge-inbox-queries'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  projectForgeItemDetail,
  projectForgeRunPage,
  type ForgeItemDetailView
} from './forge-inbox-read-projection'

const EMPTY_PAGE: ForgePage<never> = { rows: [], nextCursor: null }

/**
 * Safe, read-only views over the running ledger. `ledger` throws when the service is not running
 * and returns null while dormant, so a profile that never configured the inbox reads as empty
 * without a database file being created.
 */
export function createForgeOwnerReads(ledger: () => ForgeInboxLedger | null) {
  return {
    listItems(query: Parameters<ForgeInboxLedger['listItems']>[0]) {
      return ledger()?.listItems(query) ?? EMPTY_PAGE
    },
    /** Empty while dormant: no ledger means no project holds anything yet. */
    listProjects(): string[] {
      return ledger()?.listItemProjects() ?? []
    },
    /** Zero while dormant: an inbox nobody opened has nothing unread for this reader yet. */
    countUnread(scope: ForgeInstanceScope, clientId: string): number {
      const live = ledger()
      return live ? countUnreadForgeItems(live.ledgerContext(), { ...scope, clientId }) : 0
    },
    getItemDetail(
      scope: ForgeInstanceScope,
      itemId: number,
      clientId: string
    ): ForgeItemDetailView | null {
      const detail = ledger()?.getItemDetail(scope, itemId, clientId)
      return detail ? projectForgeItemDetail(detail) : null
    },
    listRuns(scope: ForgeInstanceScope, query: Parameters<ForgeInboxLedger['listRuns']>[1]) {
      const live = ledger()
      if (!live) {
        return EMPTY_PAGE
      }
      const page = live.listRuns(scope, query)
      return projectForgeRunPage(
        page,
        readDispatchConfirmationViews(
          live.ledgerContext(),
          page.rows.map((run) => run.id)
        ),
        readRunCancellationViews(
          live.ledgerContext(),
          page.rows.map((run) => run.id)
        ),
        readRunDispatchFacts(
          live.ledgerContext(),
          page.rows.map((run) => run.id)
        )
      )
    },
    listEvents(scope: ForgeInstanceScope, query: Parameters<ForgeInboxLedger['listEvents']>[1]) {
      return ledger()?.listEvents(scope, query) ?? EMPTY_PAGE
    },
    /** Pure read: no client cursor is written. */
    listChanges(scope: ForgeInstanceScope, query: { afterSeq: number; limit?: number }) {
      return (
        ledger()?.listChanges(scope, query) ?? {
          changes: [],
          nextSeq: query.afterSeq,
          hasMore: false
        }
      )
    },
    markRead(scope: ForgeInstanceScope, input: { clientId: string; itemId: number }): boolean {
      return ledger()?.markRead(scope, input) ?? false
    },
    /** False while dormant or stopped: nothing was dispatched, so no completion is deferred to Forge. */
    isDispatchedAgent(identity: Parameters<ForgeInboxLedger['isDispatchedAgent']>[0]): boolean {
      return ledger()?.isDispatchedAgent(identity) ?? false
    },
    archiveItem(scope: ForgeInstanceScope, input: { clientId: string; itemId: number }): boolean {
      return ledger()?.archiveItem(scope, input) ?? false
    },
    unarchiveItem(scope: ForgeInstanceScope, input: { clientId: string; itemId: number }): boolean {
      return ledger()?.unarchiveItem(scope, input) ?? false
    }
  }
}
