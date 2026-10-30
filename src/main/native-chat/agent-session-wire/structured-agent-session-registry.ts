import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
let held = false
let stopWatchingHost: (() => void) | null = null
const heldListeners = new Set<(held: boolean) => void>()
const hostListeners = new Set<(host: StructuredAgentSessionHost | null) => void>()

// Partial test hosts may omit holdsSessions.
function hostHoldsSessions(candidate: StructuredAgentSessionHost | null): boolean {
  return typeof candidate?.holdsSessions === 'function' && candidate.holdsSessions()
}

// Failed notification must not trigger host reinstallation and duplicate ownership.
function publishHeld(): void {
  try {
    const next = hostHoldsSessions(host)
    if (next === held) {
      return
    }
    held = next
    for (const listener of heldListeners) {
      try {
        listener(next)
      } catch (error) {
        console.warn('[structured-agent-session] a held-chats listener threw', error)
      }
    }
  } catch (error) {
    console.warn('[structured-agent-session] reading whether chats are held failed', error)
  }
}

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  stopWatchingHost?.()
  stopWatchingHost = null
  host = next
  try {
    stopWatchingHost =
      typeof next?.onSessionsHeld === 'function' ? next.onSessionsHeld(publishHeld) : null
  } catch (error) {
    console.warn('[structured-agent-session] watching for held chats failed', error)
  }
  for (const listener of hostListeners) {
    try {
      listener(next)
    } catch (error) {
      console.warn('[structured-agent-session] a host listener threw', error)
    }
  }
  publishHeld()
}

/** Called each time a different host is installed or cleared, so holders of the old one can let go. */
export function onStructuredAgentSessionHostChanged(
  listener: (host: StructuredAgentSessionHost | null) => void
): () => void {
  hostListeners.add(listener)
  return () => hostListeners.delete(listener)
}

/** Includes saved/live chats; constructing a host holds none. */
export function structuredAgentSessionsHeld(): boolean {
  return hostHoldsSessions(host)
}

export function onStructuredAgentSessionsHeldChanged(
  listener: (held: boolean) => void
): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
