import { useCallback } from 'react'
import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'
import type { ForgeItem } from '../../../../shared/forge-inbox-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { archiveForgeInboxItem, unarchiveForgeInboxItem } from '@/runtime/forge-inbox-client'
import type { ForgeInboxItemDetail } from './use-forge-inbox-item-detail'

export type ForgeInboxArchiveActionArgs = {
  ownerHostId: string | null
  archiveSupported: boolean | null
  archiveView: ForgeInboxArchiveView
  requestTarget: RuntimeClientTarget
  /** Bumped so an in-flight list read cannot write over the state this mutation just fixed. */
  listRequest: { current: number }
  setItems: (update: (current: ForgeItem[]) => ForgeItem[]) => void
  updateDetail: ForgeInboxItemDetail['updateDetail']
  setLoadingMore: (loading: boolean) => void
  setNextCursor: (cursor: number | null) => void
  reload: () => void
}

/** Archive is a mutation of the host's state, so the list and detail are refreshed, not patched. */
export function useForgeInboxArchiveAction(args: ForgeInboxArchiveActionArgs) {
  const {
    ownerHostId,
    archiveSupported,
    archiveView,
    requestTarget,
    listRequest,
    setItems,
    updateDetail,
    setLoadingMore,
    setNextCursor,
    reload
  } = args
  return useCallback(
    async (itemId: number, archived: boolean): Promise<boolean> => {
      if (ownerHostId === null || archiveSupported !== true) {
        return false
      }
      const request = listRequest.current
      const outcome = await (archived
        ? archiveForgeInboxItem(ownerHostId, itemId, undefined, requestTarget)
        : unarchiveForgeInboxItem(ownerHostId, itemId, undefined, requestTarget))
      if (!outcome.applied) {
        return false
      }
      if (request === listRequest.current) {
        setItems((current) =>
          archiveView === 'all'
            ? current.map((item) => (item.id === itemId ? { ...item, archived } : item))
            : current.filter((item) => item.id !== itemId)
        )
        updateDetail((current) =>
          current?.item.id === itemId
            ? { ...current, item: { ...current.item, archived } }
            : current
        )
      }
      ++listRequest.current
      setLoadingMore(false)
      setNextCursor(null)
      reload()
      return true
    },
    [
      ownerHostId,
      archiveSupported,
      archiveView,
      requestTarget,
      listRequest,
      setItems,
      updateDetail,
      setLoadingMore,
      setNextCursor,
      reload
    ]
  )
}
