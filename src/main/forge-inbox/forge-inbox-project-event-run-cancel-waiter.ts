import type { AgentSessionStatusEvent } from '../../shared/agent-session-wire'

export type StopWaiterEntry = { runId: number; sessionId: string }

type StatusFeed = {
  subscribeStatus(subscriber: {
    id: string
    emit: (event: AgentSessionStatusEvent) => void
  }): () => void
}

/**
 * Stops whose dispatched turn the host has not shown yet. The host's status feed announces a change
 * to one session, so a waiting stop is woken by its own session only, at most once per `minGapMs`,
 * and the feed is held only while something waits.
 */
export function createStopWaiter(
  onSession: (entry: StopWaiterEntry) => void,
  minGapMs: number,
  now: () => number
) {
  const entries = new Map<number, StopWaiterEntry>()
  const lastWoke = new Map<number, number>()
  let unsubscribe: (() => void) | null = null

  function drop(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  function emit(event: AgentSessionStatusEvent): void {
    if (event.type !== 'status') {
      return
    }
    for (const entry of entries.values()) {
      const last = lastWoke.get(entry.runId)
      if (
        entry.sessionId === event.session.sessionId &&
        (last === undefined || now() - last >= minGapMs)
      ) {
        lastWoke.set(entry.runId, now())
        onSession(entry)
      }
    }
  }

  return {
    park(entry: StopWaiterEntry, feed: StatusFeed | null): void {
      entries.set(entry.runId, entry)
      if (unsubscribe === null && feed) {
        unsubscribe = feed.subscribeStatus({ id: 'forge-project-event-run-cancel', emit })
      }
    },
    release(runId: number): void {
      entries.delete(runId)
      lastWoke.delete(runId)
      if (entries.size === 0) {
        drop()
      }
    },
    waitingRunIds: (): number[] => [...entries.keys()],
    /** Drops every wait whose run is no longer open. */
    retainOnly(open: ReadonlySet<number>): void {
      for (const runId of entries.keys()) {
        if (!open.has(runId)) {
          entries.delete(runId)
          lastWoke.delete(runId)
        }
      }
      if (entries.size === 0) {
        drop()
      }
    },
    clear(): void {
      entries.clear()
      lastWoke.clear()
      drop()
    }
  }
}
