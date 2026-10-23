import type { ForgeInstanceScope } from '../../../shared/forge-inbox-types'
import type { ForgeOwnerChangeHint } from '../../forge-inbox/forge-inbox-owner-hints'
import type { ForgeInboxOwnerService } from '../../forge-inbox/forge-inbox-owner-service'
import {
  FORGE_CHANGE_PAGE_SIZE,
  FORGE_CHANGE_PAGES_PER_TURN,
  FORGE_CHANGE_STREAM_WINDOW
} from './forge-inbox-change-stream-limits'

export type ForgeChangeStreamEnd = 'stopped' | 'owner-changed' | 'open-failed' | 'failed'

export type ForgeChangeStreamDeps = {
  service: ForgeInboxOwnerService
  ownerHostId: string
  scope: ForgeInstanceScope
  readerId: string
  subscriptionId: string
  afterSeq: number
  emit: (frame: Record<string, unknown>) => void
  /** Sends the end frame and closes the registration; must not throw and may be called repeatedly. */
  end: (reason: ForgeChangeStreamEnd) => void
}

export type ForgeChangeStream = ReturnType<typeof createForgeChangeStream>

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * One subscriber's cursor over the durable change feed. Hints only wake the drain; every frame is
 * read from the single `sent` cursor, so a hint can neither skip nor repeat a row.
 */
export function createForgeChangeStream(deps: ForgeChangeStreamDeps) {
  const { service, scope, readerId } = deps
  let sent = deps.afterSeq
  // The requested window position; no durable cursor is written until a new ack (equal or older acks are no-ops).
  let acked = deps.afterSeq
  const outstanding: number[] = []
  let closed = false
  let running = false
  let again = false
  let unsubscribeHints: () => void = () => undefined

  function emit(frame: Record<string, unknown>): void {
    if (closed) {
      return
    }
    try {
      deps.emit(frame)
    } catch {
      deps.end('failed')
    }
  }

  async function drainPages(): Promise<void> {
    for (let pages = 1; !closed; pages++) {
      const room = FORGE_CHANGE_STREAM_WINDOW - outstanding.length
      if (room <= 0) {
        return
      }
      const page = service.listChanges(scope, {
        afterSeq: sent,
        limit: Math.min(FORGE_CHANGE_PAGE_SIZE, room)
      })
      for (const change of page.changes) {
        sent = change.seq
        outstanding.push(change.seq)
        emit({ type: 'change', ...change })
      }
      sent = Math.max(sent, page.nextSeq)
      if (!page.hasMore) {
        return
      }
      if (pages % FORGE_CHANGE_PAGES_PER_TURN === 0) {
        await yieldToLoop()
      }
    }
  }

  async function drain(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await drainPages()
      } while (again && !closed)
    } catch {
      deps.end('failed')
    } finally {
      running = false
    }
  }

  function onHint(hint: ForgeOwnerChangeHint): void {
    if (hint.kind === 'ended') {
      deps.end(hint.reason)
      return
    }
    if (hint.readClientIds.includes(readerId)) {
      emit({ type: 'readState' })
    }
    if (hint.changes) {
      void drain()
    }
  }

  return {
    /** Listens first so a commit during catch-up is never missed, then reports where catch-up stopped. */
    async start(): Promise<void> {
      unsubscribeHints = service.subscribeChangeHints(onHint)
      await drain()
      emit({
        type: 'ready',
        subscriptionId: deps.subscriptionId,
        ownerHostId: deps.ownerHostId,
        afterSeq: deps.afterSeq,
        // The last row sent, not the durable head: a paused window leaves later rows unsent.
        latestSeq: sent
      })
    },
    scope,
    readerId,
    ownerHostId: deps.ownerHostId,
    isAckable: (seq: number) => Number.isSafeInteger(seq) && seq >= 0 && seq <= sent,
    ackedSeq: () => acked,
    /** Frees window room for rows up to seq and resumes a paused drain from `sent`. */
    release(seq: number): void {
      if (seq <= acked) {
        return
      }
      acked = seq
      while (outstanding.length > 0 && outstanding[0]! <= seq) {
        outstanding.shift()
      }
      void drain()
    },
    dispose(): void {
      closed = true
      unsubscribeHints()
    }
  }
}
