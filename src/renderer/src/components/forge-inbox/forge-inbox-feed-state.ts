import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import type { ForgeItem, ForgeItemKind } from '../../../../shared/forge-inbox-types'
import type {
  ForgeInboxStatus,
  ForgeItemDetailView
} from '../../../../shared/forge-inbox-rpc-types'
import type { ProjectEventQuestionView } from '../../../../shared/forge-inbox-project-event-question'

export type ForgeInboxFeed = {
  status: ForgeInboxStatus | null
  statusError: string | null
  items: ForgeItem[]
  itemsError: string | null
  loadingStatus: boolean
  loadingItems: boolean
  loadingMore: boolean
  hasMore: boolean
  unreadOnly: boolean
  archiveView: ForgeInboxArchiveView
  archiveSupported: boolean | null
  /** Null means every project; the options come from the host, so an old host offers none. */
  projectFilter: string | null
  kindFilter: ForgeItemKind | null
  /** Null means every handling state; the values are the design's seven states. */
  handlingFilter: ForgeItemHandlingState | null
  projects: string[]
  selectedItemId: number | null
  detail: ForgeItemDetailView | null
  questions: ProjectEventQuestionView[]
  detailError: string | null
  loadingDetail: boolean
  reload: () => void
  loadMore: () => void
  setUnreadOnly: (unread: boolean) => void
  setArchiveView: (view: ForgeInboxArchiveView) => void
  setProjectFilter: (projectId: string | null) => void
  setKindFilter: (kind: ForgeItemKind | null) => void
  setHandlingFilter: (handling: ForgeItemHandlingState | null) => void
  setItemArchived: (itemId: number, archived: boolean) => Promise<boolean>
  selectItem: (itemId: number | null) => void
}
