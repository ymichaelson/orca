import { useEffect, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readForgeInboxStatus } from '@/runtime/forge-inbox-client'

const ATTENTION_REFRESH_MS = 10_000

/** What the sidebar shows about the inbox: unread items and runs under way right now. */
export type ForgeInboxAttention = { unread: number | null; running: number }

const NOTHING: ForgeInboxAttention = { unread: null, running: 0 }

/**
 * The sidebar's view of the inbox owner it opens. `unread` stays null while the host cannot say,
 * so the badge never claims an empty inbox.
 */
export function useForgeInboxAttention(target: RuntimeClientTarget): ForgeInboxAttention {
  const [attention, setAttention] = useState<ForgeInboxAttention>(NOTHING)

  useEffect(() => {
    let disposed = false
    let inFlight = false
    setAttention(NOTHING)

    const read = () => {
      // Why: a hidden window still polls slowly, but a visible one reads immediately on return.
      if (disposed || inFlight || document.visibilityState === 'hidden') {
        return
      }
      inFlight = true
      readForgeInboxStatus(target)
        .then((status) => {
          if (disposed) {
            return
          }
          setAttention(
            status.phase === 'unattached'
              ? NOTHING
              : {
                  unread: status.unread ?? null,
                  running: status.activeRuns?.length ?? 0
                }
          )
        })
        .catch(() => {
          if (!disposed) {
            setAttention(NOTHING)
          }
        })
        .finally(() => {
          inFlight = false
        })
    }

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        read()
      }
    }
    read()
    const timer = setInterval(read, ATTENTION_REFRESH_MS)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [target])

  return attention
}
