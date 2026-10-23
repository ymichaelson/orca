import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createForgeWorkerScheduler,
  type ForgeWorkerSchedulerDeps
} from './forge-inbox-worker-scheduler'

const NOW = Date.parse('2026-10-22T00:00:00.000Z')

type Schedule = { pending: number; needsAuth: number; nextAttemptAtMs: number | null }

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('forge inbox worker scheduler', () => {
  let schedule: Schedule
  const idle: Schedule = { pending: 0, needsAuth: 0, nextAttemptAtMs: null }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    schedule = { ...idle }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const build = (drain: ForgeWorkerSchedulerDeps['drain']) =>
    createForgeWorkerScheduler({ readSchedule: () => schedule, drain, now: () => Date.now() })

  it('runs exactly one follow-up drain for any number of wakes during a drain', async () => {
    const first = deferred()
    const drain = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const scheduler = build(drain)

    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      scheduler.wake()
    }
    expect(drain).toHaveBeenCalledTimes(1)
    first.resolve()
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(2)
  })

  it('arms one timer at the earliest persisted attempt time and drains when it fires', async () => {
    schedule = { pending: 2, needsAuth: 0, nextAttemptAtMs: NOW + 5_000 }
    const drain = vi.fn().mockResolvedValue(undefined)
    const scheduler = build(drain)

    scheduler.wake()
    await scheduler.settled()
    expect(scheduler.status().timerAtMs).toBe(NOW + 5_000)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(drain).toHaveBeenCalledTimes(1)
    schedule = { ...idle }
    await vi.advanceTimersByTimeAsync(1)
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces the timer when a wake finds an earlier attempt time', async () => {
    schedule = { pending: 1, needsAuth: 0, nextAttemptAtMs: NOW + 60_000 }
    const scheduler = build(vi.fn().mockResolvedValue(undefined))
    scheduler.wake()
    await scheduler.settled()

    schedule = { pending: 2, needsAuth: 0, nextAttemptAtMs: NOW + 1_000 }
    scheduler.wake()
    await scheduler.settled()

    expect(scheduler.status().timerAtMs).toBe(NOW + 1_000)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('never polls: needs-auth rows and an empty queue leave no timer', async () => {
    const drain = vi.fn().mockResolvedValue(undefined)
    const scheduler = build(drain)
    schedule = { pending: 0, needsAuth: 3, nextAttemptAtMs: null }

    scheduler.wake()
    await scheduler.settled()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('does not spin on a row that stays due after a drain', async () => {
    schedule = { pending: 1, needsAuth: 0, nextAttemptAtMs: NOW - 1 }
    const drain = vi.fn().mockResolvedValue(undefined)
    const scheduler = build(drain)

    scheduler.wake()
    await scheduler.settled()

    expect(scheduler.status().timerAtMs).toBe(NOW + 1_000)
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('survives a failing drain and reports it', async () => {
    const onError = vi.fn()
    const drain = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const scheduler = createForgeWorkerScheduler({
      readSchedule: () => schedule,
      drain,
      now: () => Date.now(),
      onError
    })

    scheduler.wake()
    await scheduler.settled()
    scheduler.wake()
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('re-arms a fallback timer when reading the schedule fails', async () => {
    const onError = vi.fn()
    let reads = 0
    const drain = vi.fn().mockResolvedValue(undefined)
    const scheduler = createForgeWorkerScheduler({
      readSchedule: () => {
        reads += 1
        if (reads === 1) {
          throw new Error('SQLITE_BUSY')
        }
        return idle
      },
      drain,
      now: () => Date.now(),
      onError
    })

    scheduler.wake()
    await scheduler.settled()
    expect(scheduler.status().timerAtMs).toBe(NOW + 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stop clears the fallback timer of a schedule that keeps failing', async () => {
    const scheduler = createForgeWorkerScheduler({
      readSchedule: () => {
        throw new Error('SQLITE_BUSY')
      },
      drain: vi.fn().mockResolvedValue(undefined),
      now: () => Date.now()
    })
    scheduler.wake()
    await scheduler.settled()
    expect(vi.getTimerCount()).toBe(1)

    await scheduler.stop()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps draining and re-arming when the error reporter itself throws', async () => {
    let reads = 0
    const drain = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const scheduler = createForgeWorkerScheduler({
      readSchedule: () => {
        reads += 1
        if (reads === 1) {
          throw new Error('SQLITE_BUSY')
        }
        return idle
      },
      drain,
      now: () => Date.now(),
      onError: () => {
        throw new Error('reporter exploded')
      }
    })

    scheduler.wake()
    await scheduler.settled()
    expect(scheduler.status().draining).toBe(false)
    expect(scheduler.status().timerAtMs).toBe(NOW + 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(2)
    await expect(scheduler.stop()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs again at once while drains report a hit cap, without waiting for a timer', async () => {
    schedule = { pending: 1, needsAuth: 0, nextAttemptAtMs: NOW - 1 }
    const drain = vi
      .fn()
      .mockResolvedValueOnce({ capped: true })
      .mockResolvedValueOnce({ capped: true })
      .mockResolvedValue({ capped: false })
    const scheduler = build(drain)

    scheduler.wake()
    await scheduler.settled()

    expect(drain).toHaveBeenCalledTimes(3)
    expect(scheduler.status().timerAtMs).toBe(NOW + 1_000)
  })

  it('does not start another capped drain once stopped', async () => {
    const first = deferred()
    const drain = vi.fn().mockImplementation(async () => {
      await first.promise
      return { capped: true }
    })
    const scheduler = build(drain)
    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)

    const stopping = scheduler.stop()
    first.resolve()
    await stopping

    expect(drain).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop clears an already armed timer', async () => {
    schedule = { pending: 1, needsAuth: 0, nextAttemptAtMs: NOW + 5_000 }
    const drain = vi.fn().mockResolvedValue(undefined)
    const scheduler = build(drain)
    scheduler.wake()
    await scheduler.settled()
    expect(vi.getTimerCount()).toBe(1)

    await scheduler.stop()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('stop clears the timer, waits for the running drain and ignores later wakes', async () => {
    schedule = { pending: 1, needsAuth: 0, nextAttemptAtMs: NOW + 5_000 }
    const running = deferred()
    const drain = vi.fn().mockReturnValueOnce(running.promise).mockResolvedValue(undefined)
    const scheduler = build(drain)
    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)

    let stopped = false
    const stopping = scheduler.stop().then(() => (stopped = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    running.resolve()
    await stopping
    scheduler.wake()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(drain).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(scheduler.stop()).resolves.toBeUndefined()
  })
})
