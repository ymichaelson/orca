import { useCallback, useEffect, useRef, useState } from 'react'
import type { ForgeEvent, ForgeItem } from '../../../../shared/forge-inbox-types'
import type {
  ForgeInboxStatus,
  ForgeItemDetailView
} from '../../../../shared/forge-inbox-rpc-types'
import {
  listForgeInboxEvents,
  listForgeInboxItems,
  markForgeInboxItemRead,
  readForgeInboxItemDetail,
  readForgeInboxStatus
} from '@/runtime/forge-inbox-client'

const PAGE_LIMIT = 50

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
  selectedItemId: number | null
  detail: ForgeItemDetailView | null
  events: ForgeEvent[]
  detailError: string | null
  loadingDetail: boolean
  reload: () => void
  loadMore: () => void
  setUnreadOnly: (unread: boolean) => void
  selectItem: (itemId: number | null) => void
}

/** Owner-qualified reads for the host this window is attached to; every failure stays visible. */
export function useForgeInboxFeed(): ForgeInboxFeed {
  const [status, setStatus] = useState<ForgeInboxStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [items, setItems] = useState<ForgeItem[]>([])
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [unreadOnly, setUnreadOnlyState] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ForgeItemDetailView | null>(null)
  const [events, setEvents] = useState<ForgeEvent[]>([])
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // Why: a slower response for a previous owner, filter or item must not overwrite the current one.
  const statusRequest = useRef(0)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)

  const ownerHostId = status?.ownerHostId ?? null

  useEffect(() => {
    const request = ++statusRequest.current
    setLoadingStatus(true)
    setStatusError(null)
    readForgeInboxStatus()
      .then((next) => {
        if (request !== statusRequest.current) {
          return
        }
        setStatus(next)
        setLoadingStatus(false)
      })
      .catch((error: unknown) => {
        if (request !== statusRequest.current) {
          return
        }
        setStatusError(error instanceof Error ? error.message : String(error))
        setLoadingStatus(false)
      })
  }, [reloadToken])

  useEffect(() => {
    if (ownerHostId === null) {
      setItems([])
      setNextCursor(null)
      return
    }
    const request = ++listRequest.current
    setLoadingItems(true)
    setItemsError(null)
    listForgeInboxItems(ownerHostId, { unreadOnly, limit: PAGE_LIMIT })
      .then((page) => {
        if (request !== listRequest.current) {
          return
        }
        setItems(page.rows)
        setNextCursor(page.nextCursor)
        setLoadingItems(false)
      })
      .catch((error: unknown) => {
        if (request !== listRequest.current) {
          return
        }
        setItemsError(error instanceof Error ? error.message : String(error))
        setLoadingItems(false)
      })
  }, [ownerHostId, unreadOnly, reloadToken])

  useEffect(() => {
    if (selectedItemId === null || ownerHostId === null) {
      setDetail(null)
      setEvents([])
      setDetailError(null)
      return
    }
    const request = ++detailRequest.current
    const itemId = selectedItemId
    setLoadingDetail(true)
    setDetailError(null)
    void Promise.all([
      readForgeInboxItemDetail(ownerHostId, itemId),
      listForgeInboxEvents(ownerHostId, itemId, { limit: PAGE_LIMIT })
    ])
      .then(([detailResult, eventPage]) => {
        if (request !== detailRequest.current) {
          return
        }
        setDetail(detailResult.detail)
        setEvents(eventPage.rows)
        setLoadingDetail(false)
        // Why: opening an item is the read mark; a failure here must not hide the loaded detail.
        void markForgeInboxItemRead(ownerHostId, itemId)
          .then(() => {
            setItems((current) =>
              current.map((item) => (item.id === itemId ? { ...item, unread: false } : item))
            )
          })
          .catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (request !== detailRequest.current) {
          return
        }
        setDetailError(error instanceof Error ? error.message : String(error))
        setLoadingDetail(false)
      })
  }, [ownerHostId, selectedItemId, reloadToken])

  const loadMore = useCallback(() => {
    if (ownerHostId === null || nextCursor === null || loadingMore) {
      return
    }
    const request = ++listRequest.current
    setLoadingMore(true)
    listForgeInboxItems(ownerHostId, { unreadOnly, limit: PAGE_LIMIT, cursor: nextCursor })
      .then((page) => {
        if (request !== listRequest.current) {
          return
        }
        const known = new Set(items.map((item) => item.id))
        setItems([...items, ...page.rows.filter((item) => !known.has(item.id))])
        setNextCursor(page.nextCursor)
        setLoadingMore(false)
      })
      .catch((error: unknown) => {
        if (request !== listRequest.current) {
          return
        }
        setItemsError(error instanceof Error ? error.message : String(error))
        setLoadingMore(false)
      })
  }, [items, loadingMore, nextCursor, ownerHostId, unreadOnly])

  const selectItem = useCallback((itemId: number | null) => setSelectedItemId(itemId), [])
  const setUnreadOnly = useCallback((unread: boolean) => {
    setSelectedItemId(null)
    setUnreadOnlyState(unread)
  }, [])
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  return {
    status,
    statusError,
    items,
    itemsError,
    loadingStatus,
    loadingItems,
    loadingMore,
    hasMore: nextCursor !== null,
    unreadOnly,
    selectedItemId,
    detail,
    events,
    detailError,
    loadingDetail,
    reload,
    loadMore,
    setUnreadOnly,
    selectItem
  }
}
