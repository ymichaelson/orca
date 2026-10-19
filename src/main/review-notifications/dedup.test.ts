import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  advanceWatermark,
  createFileWatermarkStore,
  createInMemoryWatermarkStore,
  MAX_FINGERPRINTS,
  skewBack,
  watermarkKey,
  WATERMARK_SKEW_MS
} from './dedup'
import type { ItemSnapshot } from './transitions'

describe('dedup', () => {
  it('watermarkKey is stable and case-insensitive', () => {
    expect(watermarkKey('gitlab', 'H', 'R', 'mr-open')).toBe(
      watermarkKey('gitlab', 'h', 'r', 'mr-open')
    )
    expect(watermarkKey('gitlab', 'h', 'r', 'mr-open')).not.toBe(
      watermarkKey('gitlab', 'h', 'r', 'issue-open')
    )
  })

  it('watermarkKey gives every listing its own cursor', () => {
    const keys = (['mr-open', 'mr-closed', 'issue-open', 'issue-closed'] as const).map((k) =>
      watermarkKey('gitlab', 'h', 'r', k)
    )
    expect(new Set(keys).size).toBe(4)
  })

  it('skewBack subtracts the overlap so exclusive windows cannot skip items', () => {
    expect(skewBack('2026-10-19T12:00:00Z')).toBe('2026-10-19T11:59:00.000Z')
    expect(WATERMARK_SKEW_MS).toBe(60_000)
    expect(skewBack('2026-10-19T12:00:00Z', 1000)).toBe('2026-10-19T11:59:59.000Z')
  })

  it('advanceWatermark moves forward only (clock skew never rewinds)', () => {
    const store = createInMemoryWatermarkStore()
    const key = watermarkKey('gitlab', 'h', 'r', 'mr-open')
    expect(store.getWatermark(key)).toBeNull()
    expect(advanceWatermark(store, key, '2026-10-19T10:00:00Z')).toBe('2026-10-19T10:00:00Z')
    // Older candidate: ignored.
    expect(advanceWatermark(store, key, '2026-10-19T09:00:00Z')).toBe('2026-10-19T10:00:00Z')
    expect(store.getWatermark(key)).toBe('2026-10-19T10:00:00Z')
    // Newer candidate: advances.
    expect(advanceWatermark(store, key, '2026-10-19T11:00:00Z')).toBe('2026-10-19T11:00:00Z')
  })

  it('bounds fingerprints as an LRU', () => {
    const store = createInMemoryWatermarkStore()
    for (let i = 0; i < MAX_FINGERPRINTS + 10; i++) {
      store.addFingerprint(`fp-${i}`)
    }
    expect(store.hasFingerprint('fp-0')).toBe(false)
    expect(store.hasFingerprint(`fp-${MAX_FINGERPRINTS + 9}`)).toBe(true)
    // Re-adding is a no-op, not a duplicate.
    store.addFingerprint(`fp-${MAX_FINGERPRINTS + 9}`)
    expect(store.hasFingerprint(`fp-${MAX_FINGERPRINTS + 9}`)).toBe(true)
  })

  it('file store persists watermarks and fingerprints across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
    const file = join(dir, 'state.json')
    const first = createFileWatermarkStore(file)
    const key = watermarkKey('gitlab', 'h', 'r', 'mr-open')
    first.setWatermark(key, '2026-10-19T10:00:00Z')
    first.addFingerprint('abc123')
    await first.flush()

    const second = createFileWatermarkStore(file)
    await second.flush() // no-op flush still ensures load completed
    // Give the async load a tick; flush awaited ensureLoaded.
    expect(second.getWatermark(key)).toBe('2026-10-19T10:00:00Z')
    expect(second.hasFingerprint('abc123')).toBe(true)
  })

  it('file store starts empty when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
    const store = createFileWatermarkStore(join(dir, 'nope', 'state.json'))
    expect(store.getWatermark('k')).toBeNull()
    expect(store.hasFingerprint('x')).toBe(false)
    await store.flush() // creates parent dirs
  })

  it('serializes concurrent flushes: writes never overlap', async () => {
    const { promises: nodeFs } = await import('node:fs')
    let inFlight = 0
    let maxInFlight = 0
    let notifyWriteStarted!: () => void
    const writeStarted = new Promise<void>((r) => {
      notifyWriteStarted = r
    })
    let releaseWrite!: () => void
    const writeCanFinish = new Promise<void>((r) => {
      releaseWrite = r
    })
    const spy = vi.spyOn(nodeFs, 'writeFile')
    // The atomic rename is covered by its own test; here it is a no-op so the
    // write-tracking mock above does not need to touch the filesystem.
    const renameSpy = vi.spyOn(nodeFs, 'rename').mockImplementation(async () => {})
    // Observe write overlap without touching the real filesystem: the mock
    // only tracks in-flight writes and waits on an explicit gate.
    spy.mockImplementation(async (..._args: [unknown, unknown, unknown?]) => {
      const first = inFlight === 0
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (first) {
        notifyWriteStarted()
      }
      // Hold the first write open so a concurrent flush would overlap it.
      await writeCanFinish
      inFlight -= 1
    })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
      const file = join(dir, 'state.json')
      const store = createFileWatermarkStore(file)
      store.setWatermark('k', '2026-10-19T10:00:00Z')
      const first = store.flush()
      await writeStarted
      store.setWatermark('k2', '2026-10-19T11:00:00Z')
      const second = store.flush()
      // Give the second flush a chance to (incorrectly) start its own write.
      await new Promise((r) => setTimeout(r, 50))
      expect(maxInFlight).toBeLessThanOrEqual(1)
      releaseWrite()
      await Promise.all([first, second])
    } finally {
      spy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  it('concurrent flushes never lose updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
    const file = join(dir, 'state.json')
    const store = createFileWatermarkStore(file)
    store.setWatermark('k', '2026-10-19T10:00:00Z')
    const first = store.flush()
    // Mutate while the first flush is queued: the second flush must persist it.
    store.setWatermark('k2', '2026-10-19T11:00:00Z')
    const second = store.flush()
    await Promise.all([first, second])
    const reread = createFileWatermarkStore(file)
    await reread.flush()
    expect(reread.getWatermark('k')).toBe('2026-10-19T10:00:00Z')
    expect(reread.getWatermark('k2')).toBe('2026-10-19T11:00:00Z')
  })

  it('writes atomically via temp file + rename', async () => {
    const { promises: nodeFs } = await import('node:fs')
    const renameSpy = vi.spyOn(nodeFs, 'rename')
    try {
      const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
      const file = join(dir, 'state.json')
      const store = createFileWatermarkStore(file)
      store.setWatermark('k', '2026-10-19T10:00:00Z')
      await store.flush()
      expect(renameSpy).toHaveBeenCalled()
      const firstCall = renameSpy.mock.calls[0]
      expect(firstCall).toBeDefined()
      const [tmp, target] = firstCall ?? []
      expect(target).toBe(file)
      expect(String(tmp)).toMatch(/\.tmp$/)
      // No temp files left behind.
      expect(await nodeFs.readdir(dir)).toEqual(['state.json'])
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('persists snapshots across instances (restart keeps transition state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-notifications-'))
    const file = join(dir, 'state.json')
    const snapshot: ItemSnapshot = {
      iid: 7,
      updatedAt: '2026-10-19T10:00:00Z',
      draft: false,
      reviewers: [],
      labels: [],
      title: 'Add search'
    }
    const first = createFileWatermarkStore(file)
    first.setSnapshot('gitlab|h|r|mr|7', snapshot)
    await first.flush()

    const second = createFileWatermarkStore(file)
    await second.flush()
    expect(second.getSnapshot('gitlab|h|r|mr|7')).toMatchObject({
      iid: 7,
      updatedAt: '2026-10-19T10:00:00Z'
    })
    second.deleteSnapshot('gitlab|h|r|mr|7')
    expect(second.getSnapshot('gitlab|h|r|mr|7')).toBeUndefined()
  })
})
