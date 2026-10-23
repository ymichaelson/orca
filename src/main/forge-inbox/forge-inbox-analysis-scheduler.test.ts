import { describe, expect, it, vi } from 'vitest'
import { createForgeAnalysisScheduler } from './forge-inbox-analysis-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('forge analysis scheduler', () => {
  it('runs one drain at a time and coalesces a wake that lands mid-drain', async () => {
    const gate = deferred()
    let drains = 0
    const scheduler = createForgeAnalysisScheduler({
      drain: async () => {
        drains += 1
        if (drains === 1) {
          await gate.promise
        }
      }
    })

    scheduler.wake()
    scheduler.wake()
    expect(drains).toBe(1)

    gate.resolve()
    await scheduler.settled()
    expect(drains).toBe(2)
  })

  it('keeps draining while a wake lands after the drain finished', async () => {
    let drains = 0
    const scheduler = createForgeAnalysisScheduler({ drain: async () => void (drains += 1) })

    scheduler.wake()
    await scheduler.settled()
    scheduler.wake()
    await scheduler.settled()

    expect(drains).toBe(2)
  })

  it('aborts the drain on stop and waits for it to settle', async () => {
    let signal: AbortSignal | undefined
    const started = deferred()
    let stopped = false
    const scheduler = createForgeAnalysisScheduler({
      drain: async (stopping) => {
        signal = stopping
        started.resolve()
        await new Promise<void>((resolve) =>
          stopping.addEventListener('abort', () => resolve(), { once: true })
        )
        stopped = true
      }
    })

    scheduler.wake()
    await started.promise
    await scheduler.stop()

    expect(signal?.aborted).toBe(true)
    expect(stopped).toBe(true)
  })

  it('drains nothing after stop', async () => {
    const drain = vi.fn(async () => undefined)
    const scheduler = createForgeAnalysisScheduler({ drain })

    await scheduler.stop()
    scheduler.wake()
    await scheduler.settled()

    expect(drain).not.toHaveBeenCalled()
    expect(scheduler.status().draining).toBe(false)
  })

  it('reports a failed drain and stays able to run the next one', async () => {
    const onError = vi.fn()
    let drains = 0
    const scheduler = createForgeAnalysisScheduler({
      onError,
      drain: async () => {
        drains += 1
        if (drains === 1) {
          throw new Error('ledger busy')
        }
      }
    })

    scheduler.wake()
    await scheduler.settled()
    scheduler.wake()
    await scheduler.settled()

    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'ledger busy' })
    expect(drains).toBe(2)
  })
})
