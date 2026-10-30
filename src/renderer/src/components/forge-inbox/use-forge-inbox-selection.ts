import { useCallback, useState } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type OwnerSelection = { ownerHostId: string; targetHostId: ExecutionHostId; itemId: number }

/** The selected item is only meaningful under the owner and target it was picked from. */
export function useForgeInboxSelection(ownerHostId: string | null, targetHostId: ExecutionHostId) {
  const [selection, setSelection] = useState<OwnerSelection | null>(null)
  const selectedItemId =
    selection !== null &&
    selection.ownerHostId === ownerHostId &&
    selection.targetHostId === targetHostId
      ? selection.itemId
      : null
  const selectItem = useCallback(
    (itemId: number | null) => {
      setSelection(
        itemId === null || ownerHostId === null ? null : { ownerHostId, targetHostId, itemId }
      )
    },
    [ownerHostId, targetHostId]
  )
  const clearSelection = useCallback(() => setSelection(null), [])
  return { selectedItemId, selectItem, clearSelection }
}
