import type { ForgeInboxLedger } from './forge-inbox-ledger'

const WATCH_INTERVAL_MS = 30_000

/** A session-gated power hold: present on hosts that can keep the machine awake, absent elsewhere. */
export type ForgeOpenQuestionHold = {
  acquireExternalHold: (reason: string) => { release: () => void }
}

export type ForgeOpenQuestionWatch = {
  /** Re-reads now instead of waiting for the next tick. */
  refresh: () => void
  /** Stops watching and releases any hold it still owns. */
  stop: () => void
}

/**
 * A question raised by background work has no run a client watches, so the owner holds the machine
 * awake while one is open: nothing may idle-sleep past the answer the agent is waiting for.
 */
export function attachForgeOpenQuestionWatch(
  ledger: ForgeInboxLedger,
  holds: ForgeOpenQuestionHold | null,
  onError: (error: unknown) => void
): ForgeOpenQuestionWatch | null {
  if (holds === null) {
    return null
  }
  const ctx = ledger.ledgerContext()
  let hold: { release: () => void } | null = null
  let stopped = false

  function releaseHold(): void {
    const released = hold
    hold = null
    if (released === null) {
      return
    }
    try {
      released.release()
    } catch (error) {
      onError(error)
    }
  }

  function refresh(): void {
    if (stopped) {
      return
    }
    let open: boolean
    try {
      open =
        ctx.db
          .prepare(
            `SELECT 1 AS found FROM project_event_questions WHERE host_id = ? AND status = 'open' LIMIT 1`
          )
          .get(ctx.hostId) !== undefined
    } catch (error) {
      onError(error)
      return
    }
    if (!open) {
      releaseHold()
      return
    }
    if (hold !== null) {
      return
    }
    try {
      hold = holds?.acquireExternalHold('forge-inbox:open-question') ?? null
    } catch (error) {
      onError(error)
    }
  }

  refresh()
  const timer = setInterval(refresh, WATCH_INTERVAL_MS)
  timer.unref()
  return {
    refresh,
    stop() {
      stopped = true
      clearInterval(timer)
      releaseHold()
    }
  }
}
