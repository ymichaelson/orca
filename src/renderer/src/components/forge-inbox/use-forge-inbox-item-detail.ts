import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ForgeItemDetailView } from '../../../../shared/forge-inbox-rpc-types'
import type { ProjectEventQuestionView } from '../../../../shared/forge-inbox-project-event-question'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { markForgeInboxItemRead, readForgeInboxItemDetail } from '@/runtime/forge-inbox-client'
import { readProjectEventQuestions } from '@/runtime/project-event-client'
import { forgeGenericErrorLabel } from './forge-inbox-error-code-copy'

/** The payload is tagged with the owner/target/item/reload key it was loaded for. */
type LoadedDetail = {
  loadKey: string
  detail: ForgeItemDetailView | null
  questions: ProjectEventQuestionView[]
  detailError: string | null
  loadingDetail: boolean
}

type DetailPatch = Partial<Omit<LoadedDetail, 'loadKey'>>

export type ForgeInboxItemDetail = {
  detail: ForgeItemDetailView | null
  questions: ProjectEventQuestionView[]
  detailError: string | null
  loadingDetail: boolean
  updateDetail: (
    updater: (current: ForgeItemDetailView | null) => ForgeItemDetailView | null
  ) => void
}

const NOTHING_LOADED: LoadedDetail = {
  loadKey: '',
  detail: null,
  questions: [],
  detailError: null,
  loadingDetail: false
}

/** A response merges into its own key's payload; a different key starts from the empty one. */
function mergeLoaded(
  previous: LoadedDetail,
  empty: LoadedDetail,
  patch: DetailPatch
): LoadedDetail {
  return { ...(previous.loadKey === empty.loadKey ? previous : empty), ...patch }
}

/** Owner- and target-qualified detail for the selected item; a late response never lands elsewhere. */
export function useForgeInboxItemDetail({
  ownerHostId,
  itemId,
  targetHostId,
  requestTarget,
  reloadToken,
  onMarkedRead
}: {
  ownerHostId: string | null
  itemId: number | null
  targetHostId: ExecutionHostId
  requestTarget: RuntimeClientTarget
  reloadToken: number
  onMarkedRead: (itemId: number) => void
}): ForgeInboxItemDetail {
  const [loaded, setLoaded] = useState<LoadedDetail>(NOTHING_LOADED)
  // Why: a slower response for a previous owner or target must not overwrite the current one.
  const request = useRef(0)
  const loadKey = JSON.stringify([targetHostId, ownerHostId, itemId, reloadToken])

  useEffect(() => {
    const current = ++request.current
    if (itemId === null || ownerHostId === null) {
      return
    }
    const empty: LoadedDetail = {
      loadKey,
      detail: null,
      questions: [],
      detailError: null,
      loadingDetail: true
    }
    // Why separate: questions are auxiliary, and a host without them must still show the item.
    void readProjectEventQuestions(ownerHostId, 'open', requestTarget)
      .then((page) => {
        if (current === request.current) {
          setLoaded((previous) =>
            mergeLoaded(previous, empty, {
              questions: page.questions.filter((question) => question.itemId === itemId)
            })
          )
        }
      })
      .catch(() => {
        if (current === request.current) {
          setLoaded((previous) => mergeLoaded(previous, empty, { questions: [] }))
        }
      })
    void readForgeInboxItemDetail(ownerHostId, itemId, undefined, requestTarget)
      .then((result) => {
        if (current !== request.current) {
          return
        }
        setLoaded((previous) =>
          mergeLoaded(previous, empty, { detail: result.detail, loadingDetail: false })
        )
        // Why: opening an item is the read mark; a failure here must not hide the loaded detail.
        void markForgeInboxItemRead(ownerHostId, itemId, undefined, requestTarget)
          .then(() => {
            if (current === request.current) {
              onMarkedRead(itemId)
            }
          })
          .catch(() => undefined)
      })
      .catch(() => {
        if (current !== request.current) {
          return
        }
        setLoaded((previous) =>
          mergeLoaded(previous, empty, {
            detailError: forgeGenericErrorLabel(),
            loadingDetail: false
          })
        )
      })
  }, [ownerHostId, itemId, requestTarget, loadKey, onMarkedRead])

  const updateDetail = useCallback(
    (updater: (current: ForgeItemDetailView | null) => ForgeItemDetailView | null) => {
      setLoaded((previous) =>
        previous.loadKey === loadKey ? { ...previous, detail: updater(previous.detail) } : previous
      )
    },
    [loadKey]
  )

  const isCurrent = loaded.loadKey === loadKey
  return {
    detail: isCurrent ? loaded.detail : null,
    questions: isCurrent ? loaded.questions : [],
    detailError: isCurrent ? loaded.detailError : null,
    loadingDetail: isCurrent ? loaded.loadingDetail : itemId !== null && ownerHostId !== null,
    updateDetail
  }
}
