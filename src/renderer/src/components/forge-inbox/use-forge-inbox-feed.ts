import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { forgeGenericErrorLabel } from './forge-inbox-error-code-copy'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import type { ForgeItem, ForgeItemKind } from '../../../../shared/forge-inbox-types'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  getRuntimeTargetHostId,
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/runtime-client-target'
import { listForgeInboxItems, readForgeInboxStatus } from '@/runtime/forge-inbox-client'
import { useForgeInboxArchiveSupport } from './use-forge-inbox-archive-support'
import { useForgeInboxItemDetail } from './use-forge-inbox-item-detail'
import { useForgeInboxArchiveAction } from './use-forge-inbox-archive-action'
import { useForgeInboxNarrowing } from './use-forge-inbox-narrowing'
import { useForgeInboxSelection } from './use-forge-inbox-selection'
import { listFilter } from './forge-inbox-list-filter'
import type { ForgeInboxFeed } from './forge-inbox-feed-state'

export type { ForgeInboxFeed } from './forge-inbox-feed-state'

const PAGE_LIMIT = 50
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** Owner-qualified reads for one runtime target; every failure stays visible. */
export function useForgeInboxFeed(target: RuntimeClientTarget = LOCAL_TARGET): ForgeInboxFeed {
  // Why: a fresh target object per render must not refetch; only its environment matters.
  const environmentId = runtimeTargetEnvironmentId(target)
  const requestTarget = useMemo(
    () => runtimeTargetForOwnerEnvironment(environmentId),
    [environmentId]
  )
  const targetHostId = getRuntimeTargetHostId(requestTarget)
  const [statusState, setStatusState] = useState<{
    hostId: ExecutionHostId
    status: ForgeInboxStatus | null
  } | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [items, setItems] = useState<ForgeItem[]>([])
  const [listOwner, setListOwner] = useState<string | null>(null)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const unreadOnly = useAppStore((state) => state.forgeInboxUnreadOnly)
  const storedArchiveView = useAppStore((state) => state.forgeInboxArchiveView)
  const setUnreadOnlyPreference = useAppStore((state) => state.setForgeInboxUnreadOnly)
  const setArchiveViewPreference = useAppStore((state) => state.setForgeInboxArchiveView)
  const [reloadToken, setReloadToken] = useState(0)
  const archiveSupported = useForgeInboxArchiveSupport(requestTarget, reloadToken)
  const archiveView: ForgeInboxArchiveView =
    archiveSupported === true ? storedArchiveView : 'active'
  // Why: a slower response for a previous owner or filter must not overwrite the current one.
  const statusRequest = useRef(0)
  const listRequest = useRef(0)

  // Why: the previous target's owner must not stand in while the new host answers.
  const statusIsCurrent = statusState?.hostId === targetHostId
  const currentStatus = statusIsCurrent ? statusState.status : null
  const ownerHostId = currentStatus?.ownerHostId ?? null
  const { selectedItemId, selectItem, clearSelection } = useForgeInboxSelection(
    ownerHostId,
    targetHostId
  )

  useEffect(() => {
    const request = ++statusRequest.current
    setLoadingStatus(true)
    setStatusError(null)
    readForgeInboxStatus(requestTarget)
      .then((next) => {
        if (request !== statusRequest.current) {
          return
        }
        setStatusState({ hostId: targetHostId, status: next })
        setLoadingStatus(false)
      })
      .catch(() => {
        if (request !== statusRequest.current) {
          return
        }
        // Why: keep a same-host status through a failed reload, but never another host's.
        setStatusState((previous) =>
          previous?.hostId === targetHostId ? previous : { hostId: targetHostId, status: null }
        )
        setStatusError(forgeGenericErrorLabel())
        setLoadingStatus(false)
      })
  }, [requestTarget, targetHostId, reloadToken])

  const {
    projects,
    projectFilter,
    kindFilter,
    handlingFilter,
    setProjectFilter: narrowProject,
    setKindFilter: narrowKind,
    setHandlingFilter: narrowHandling
  } = useForgeInboxNarrowing(ownerHostId, requestTarget, reloadToken)

  useEffect(() => {
    const request = ++listRequest.current
    setLoadingMore(false)
    setNextCursor(null)
    setListOwner(ownerHostId)
    setItems([])
    if (ownerHostId === null) {
      setLoadingItems(false)
      setItemsError(null)
      return
    }
    setLoadingItems(true)
    setItemsError(null)
    listForgeInboxItems(
      ownerHostId,
      {
        ...listFilter(unreadOnly, archiveView, projectFilter, kindFilter, handlingFilter),
        limit: PAGE_LIMIT
      },
      requestTarget
    )
      .then((page) => {
        if (request !== listRequest.current) {
          return
        }
        setItems(page.rows)
        setNextCursor(page.nextCursor)
        setLoadingItems(false)
      })
      .catch(() => {
        if (request !== listRequest.current) {
          return
        }
        setItemsError(forgeGenericErrorLabel())
        setLoadingItems(false)
      })
  }, [
    ownerHostId,
    unreadOnly,
    archiveView,
    projectFilter,
    kindFilter,
    handlingFilter,
    requestTarget,
    reloadToken
  ])

  const markItemRead = useCallback((itemId: number) => {
    setItems((current) =>
      current.map((item) => (item.id === itemId ? { ...item, unread: false } : item))
    )
  }, [])
  const { detail, questions, detailError, loadingDetail, updateDetail } = useForgeInboxItemDetail({
    ownerHostId,
    itemId: selectedItemId,
    targetHostId,
    requestTarget,
    reloadToken,
    onMarkedRead: markItemRead
  })

  const loadMore = useCallback(() => {
    if (
      ownerHostId === null ||
      ownerHostId !== listOwner ||
      nextCursor === null ||
      loadingItems ||
      loadingMore
    ) {
      return
    }
    const request = ++listRequest.current
    setLoadingMore(true)
    listForgeInboxItems(
      ownerHostId,
      {
        ...listFilter(unreadOnly, archiveView, projectFilter, kindFilter, handlingFilter),
        limit: PAGE_LIMIT,
        cursor: nextCursor
      },
      requestTarget
    )
      .then((page) => {
        if (request !== listRequest.current) {
          return
        }
        setItems((current) => {
          const known = new Set(current.map((item) => item.id))
          return [...current, ...page.rows.filter((item) => !known.has(item.id))]
        })
        setNextCursor(page.nextCursor)
        setLoadingMore(false)
      })
      .catch(() => {
        if (request !== listRequest.current) {
          return
        }
        setItemsError(forgeGenericErrorLabel())
        setLoadingMore(false)
      })
  }, [
    loadingItems,
    loadingMore,
    nextCursor,
    ownerHostId,
    listOwner,
    unreadOnly,
    archiveView,
    projectFilter,
    kindFilter,
    handlingFilter,
    requestTarget
  ])

  const setUnreadOnly = useCallback(
    (unread: boolean) => {
      clearSelection()
      setUnreadOnlyPreference(unread)
    },
    [clearSelection, setUnreadOnlyPreference]
  )
  const setArchiveView = useCallback(
    (view: ForgeInboxArchiveView) => {
      clearSelection()
      setArchiveViewPreference(view)
    },
    [clearSelection, setArchiveViewPreference]
  )
  const setProjectFilter = useCallback(
    (projectId: string | null) => {
      clearSelection()
      narrowProject(projectId)
    },
    [clearSelection, narrowProject]
  )
  const setKindFilter = useCallback(
    (kind: ForgeItemKind | null) => {
      clearSelection()
      narrowKind(kind)
    },
    [clearSelection, narrowKind]
  )
  const setHandlingFilter = useCallback(
    (handling: ForgeItemHandlingState | null) => {
      clearSelection()
      narrowHandling(handling)
    },
    [clearSelection, narrowHandling]
  )
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const setItemArchived = useForgeInboxArchiveAction({
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
  })

  return {
    status: currentStatus,
    statusError: statusIsCurrent ? statusError : null,
    items: listOwner === ownerHostId ? items : [],
    itemsError: listOwner === ownerHostId ? itemsError : null,
    loadingStatus,
    loadingItems: listOwner === ownerHostId ? loadingItems : ownerHostId !== null,
    loadingMore: listOwner === ownerHostId && loadingMore,
    hasMore: listOwner === ownerHostId && nextCursor !== null,
    unreadOnly,
    archiveView,
    archiveSupported,
    projectFilter,
    kindFilter,
    handlingFilter,
    projects,
    selectedItemId,
    detail,
    questions,
    detailError,
    loadingDetail,
    reload,
    loadMore,
    setUnreadOnly,
    setArchiveView,
    setProjectFilter,
    setKindFilter,
    setHandlingFilter,
    setItemArchived,
    selectItem
  }
}
