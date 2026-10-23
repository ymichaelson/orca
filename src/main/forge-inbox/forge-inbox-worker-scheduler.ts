import type { ForgeWebhookWorkSchedule } from './forge-inbox-webhook-delivery-state'

const MAX_TIMER_MS = 2 ** 31 - 1
const STILL_DUE_FLOOR_MS = 1000

export type ForgeWorkerSchedulerDeps = {
  readSchedule: () => ForgeWebhookWorkSchedule
  /** `capped` means the drain stopped at its batch limit with work possibly left. */
  drain: () => Promise<{ capped?: boolean } | void>
  now: () => number
  onError?: (error: unknown) => void
}

/** One drain at a time, wakes coalesce, and a single timer follows the durable earliest attempt. */
export function createForgeWorkerScheduler(deps: ForgeWorkerSchedulerDeps) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerAtMs: number | null = null
  let running: Promise<void> | null = null
  let rerun = false
  let stopped = false

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = null
    timerAtMs = null
  }

  function armAt(atMs: number): void {
    const now = deps.now()
    timerAtMs = Math.max(atMs, now)
    timer = setTimeout(
      () => {
        timer = null
        timerAtMs = null
        wake()
      },
      Math.min(timerAtMs - now, MAX_TIMER_MS)
    )
  }

  function arm(failed: boolean): void {
    clearTimer()
    if (stopped) {
      return
    }
    let schedule: ForgeWebhookWorkSchedule
    try {
      schedule = deps.readSchedule()
    } catch (error) {
      // Persisted retries must not wait for an outside wake just because one read failed.
      report(error)
      armAt(deps.now() + STILL_DUE_FLOOR_MS)
      return
    }
    const { pending, nextAttemptAtMs } = schedule
    if (pending === 0 || nextAttemptAtMs === null) {
      return
    }
    const now = deps.now()
    armAt(
      Math.max(nextAttemptAtMs, failed || nextAttemptAtMs <= now ? now + STILL_DUE_FLOOR_MS : 0)
    )
  }

  function report(error: unknown): void {
    try {
      deps.onError?.(error)
    } catch {
      // A broken reporter must never wedge the scheduler.
    }
  }

  async function loop(): Promise<void> {
    let failed = false
    try {
      do {
        rerun = false
        failed = false
        try {
          const outcome = await deps.drain()
          if (outcome?.capped === true) {
            rerun = true
          }
        } catch (error) {
          failed = true
          report(error)
        }
      } while (rerun && !stopped)
    } finally {
      running = null
      arm(failed)
    }
  }

  function wake(): void {
    if (stopped) {
      return
    }
    if (running) {
      rerun = true
      return
    }
    clearTimer()
    running = loop()
  }

  return {
    wake,
    /** Waits for the running drain only; an armed retry timer does not hold it open. */
    async settled(): Promise<void> {
      while (running) {
        await running
      }
    },
    status: () => ({ draining: running !== null, timerAtMs }),
    async stop(): Promise<void> {
      stopped = true
      clearTimer()
      await running
    }
  }
}
