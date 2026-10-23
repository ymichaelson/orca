export type ForgeAnalysisSchedulerDeps = {
  /** `stopping` aborts on stop; the drain should return rather than throw when it does. */
  drain: (stopping: AbortSignal) => Promise<void>
  onError?: (error: unknown) => void
}

/** One analysis drain at a time, wakes coalesce, and stop aborts the drain in flight. */
export function createForgeAnalysisScheduler(deps: ForgeAnalysisSchedulerDeps) {
  const stopping = new AbortController()
  let running: Promise<void> | null = null
  let rerun = false
  let stopped = false

  function report(error: unknown): void {
    try {
      deps.onError?.(error)
    } catch {
      // A broken reporter must never wedge the scheduler.
    }
  }

  async function loop(): Promise<void> {
    try {
      do {
        rerun = false
        try {
          await deps.drain(stopping.signal)
        } catch (error) {
          report(error)
        }
      } while (rerun && !stopped)
    } finally {
      running = null
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
    running = loop()
  }

  return {
    wake,
    /** Waits for the running drain, including any wake it coalesced. */
    async settled(): Promise<void> {
      while (running) {
        await running
      }
    },
    status: () => ({ draining: running !== null }),
    async stop(): Promise<void> {
      stopped = true
      stopping.abort()
      await running
    }
  }
}
