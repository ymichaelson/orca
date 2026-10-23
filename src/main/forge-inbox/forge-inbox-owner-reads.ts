import type { ForgePage, ForgeInstanceScope } from '../../shared/forge-inbox-types'
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
      return live ? projectForgeRunPage(live.listRuns(scope, query)) : EMPTY_PAGE
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
    }
  }
}
