import type Database from '../sqlite/sync-database'

/** Metadata only: subscribers re-read through the normal queries, so no row or secret travels here. */
export type ForgeCommitHint = { changes: boolean; readClientIds: readonly string[] }
export type ForgeCommitListener = (hint: ForgeCommitHint) => void

type Commit = {
  changes: boolean
  readClientIds: ReadonlySet<string>
  /** Fixed at commit time so a listener registered later never hears an earlier commit. */
  targets: ReadonlySet<ForgeCommitListener>
}

export type ForgeCommitSignal = ReturnType<typeof createForgeCommitSignal>

function totalChanges(db: Database.Database): number {
  return Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0)
}

function createForgeCommitSignal(db: Database.Database) {
  const listeners = new Set<ForgeCommitListener>()
  let closed = false
  let pending: Commit[] = []
  let scheduled = false
  let baseline = 0
  let txChanges = false
  let txReaders = new Set<string>()

  function flush(): void {
    scheduled = false
    const ready = pending
    pending = []
    if (closed) {
      return
    }
    for (const listener of new Set(ready.flatMap((commit) => [...commit.targets]))) {
      if (!listeners.has(listener)) {
        continue
      }
      const heard = ready.filter((commit) => commit.targets.has(listener))
      const hint: ForgeCommitHint = {
        changes: heard.some((commit) => commit.changes),
        readClientIds: [...new Set(heard.flatMap((commit) => [...commit.readClientIds]))]
      }
      try {
        listener(hint)
      } catch (error) {
        console.warn('[forge-inbox] commit listener failed', error)
      }
    }
  }

  return {
    begin(): void {
      baseline = totalChanges(db)
      txChanges = false
      txReaders = new Set()
    },
    /** Called only after COMMIT succeeded; a transaction that wrote nothing emits nothing. */
    committed(): void {
      try {
        if (closed || listeners.size === 0 || totalChanges(db) === baseline) {
          return
        }
        pending.push({
          changes: txChanges,
          readClientIds: txReaders,
          targets: new Set(listeners)
        })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      } catch (error) {
        console.warn('[forge-inbox] recording a commit hint failed', error)
      }
    },
    abandon(): void {
      txChanges = false
      txReaders = new Set()
    },
    markChanges(): void {
      txChanges = true
    },
    markRead(clientId: string): void {
      txReaders.add(clientId)
    },
    subscribe(listener: ForgeCommitListener): () => void {
      if (!closed) {
        listeners.add(listener)
      }
      return () => {
        listeners.delete(listener)
      }
    },
    close(): void {
      closed = true
      listeners.clear()
      pending = []
    }
  }
}

const signals = new WeakMap<Database.Database, ForgeCommitSignal>()

/** One per connection, so every write path that shares the connection is observed. */
export function forgeCommitSignal(db: Database.Database): ForgeCommitSignal {
  let signal = signals.get(db)
  if (!signal) {
    signal = createForgeCommitSignal(db)
    signals.set(db, signal)
  }
  return signal
}
