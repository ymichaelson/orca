import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForgeInboxListItem } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readForgeInboxItemDetail } from '@/runtime/forge-inbox-client'
import { forgeEventLabel } from './forge-inbox-event-label'

export type ForgeItemEventLabels = {
  for(item: { id: number; kind: ForgeInboxListItem['kind'] }): string | null
}

const MAX_ITEMS = 50

/**
 * Names what triggered each listed item from its own detail, in one serial read per activity: a row
 * shows why it exists without the reader opening it, and nothing keeps polling.
 */
export function useForgeItemEventLabels(
  ownerHostId: string | null,
  items: readonly ForgeInboxListItem[],
  target: RuntimeClientTarget
): ForgeItemEventLabels {
  const [labels, setLabels] = useState<ReadonlyMap<number, string>>(new Map())
  const pending = useRef(0)

  useEffect(() => {
    if (ownerHostId === null || items.length === 0) {
      return
    }
    let live = true
    const request = ++pending.current
    void readLabels(ownerHostId, items, target).then((answers) => {
      // Why: a newer list has its own answers; a slower older read must not overwrite them.
      if (!live || request !== pending.current) {
        return
      }
      setLabels((current) => {
        const next = new Map(current)
        for (const [itemId, label] of answers) {
          next.delete(itemId)
          next.set(itemId, label)
        }
        while (next.size > MAX_ITEMS) {
          const oldest = next.keys().next().value
          if (oldest === undefined) {
            break
          }
          next.delete(oldest)
        }
        return next
      })
    })
    return () => {
      live = false
    }
  }, [ownerHostId, items, target])

  return useMemo(() => ({ for: (item) => labels.get(item.id) ?? null }), [labels])
}

async function readLabels(
  ownerHostId: string,
  items: readonly ForgeInboxListItem[],
  target: RuntimeClientTarget
): Promise<[number, string][]> {
  const answers: [number, string][] = []
  for (const item of items.slice(0, MAX_ITEMS)) {
    try {
      const { detail } = await readForgeInboxItemDetail(ownerHostId, item.id, undefined, target)
      const latest = detail?.timeline?.find((entry) => entry.kind === 'event')
      if (latest !== undefined && latest.kind === 'event') {
        answers.push([item.id, forgeEventLabel(item.kind, latest.eventKind, latest.summary)])
      }
    } catch {
      // An unreadable item keeps its title; the row is still a real item.
    }
  }
  return answers
}
