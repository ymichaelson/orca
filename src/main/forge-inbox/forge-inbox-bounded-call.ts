export type Bounded<T> = { ok: true; value: T } | { ok: false }

/**
 * Settles `not ok` on timeout, on failure, or when the signal aborts; its timer never outlives the
 * call. A null timeout waits as long as the work does, still ending at once on an abort.
 */
export function boundedCall<T>(
  signal: AbortSignal,
  work: Promise<T>,
  timeoutMs: number | null
): Promise<Bounded<T>> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false })
      return
    }
    const finish = (result: Bounded<T>): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish({ ok: false })
    const timer = timeoutMs === null ? undefined : setTimeout(onAbort, timeoutMs)
    timer?.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false })
    )
  })
}
