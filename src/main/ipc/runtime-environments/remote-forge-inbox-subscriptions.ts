import type { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime-shared-control-connection'
import type { RemoteRuntimeSharedSubscription } from '../../../shared/remote-runtime-shared-control-types'
import {
  boundedString,
  parseRemoteForgeNotification
} from '../../notifications/remote-forge-inbox-notification'

type RemoteForgeEvent = NonNullable<ReturnType<typeof parseRemoteForgeNotification>>
type RemoteForgeInboxSubscription = {
  connection: RemoteRuntimeSharedControlConnection
  abort: AbortController
  subscription: RemoteRuntimeSharedSubscription | null
  ready: boolean
  seen: Set<string>
}

const SEEN_KEY_LIMIT = 512

function isReadyResult(value: object): boolean {
  return (
    'subscriptionId' in value &&
    boundedString(value.subscriptionId) &&
    'epoch' in value &&
    boundedString(value.epoch)
  )
}

// Why: without epoch/seq a frame cannot be told from a repeat, so equal subjects collapse either way; bounded, not exactly-once.
function claimAnnouncement(entry: RemoteForgeInboxSubscription, event: RemoteForgeEvent): boolean {
  const cursorKey =
    event.notificationEpoch !== undefined && event.notificationSeq !== undefined
      ? JSON.stringify(['cursor', event.notificationEpoch, event.notificationSeq])
      : null
  const cursorlessSubjectKey = JSON.stringify(['subject-poor', event.subject])
  const cursorSubjectKey = JSON.stringify(['subject-rich', event.subject])
  const notificationKey =
    event.notificationId !== undefined
      ? JSON.stringify(['notification', event.notificationId])
      : null
  if (cursorKey !== null) {
    if (entry.seen.has(cursorKey) || entry.seen.has(cursorlessSubjectKey)) {
      entry.seen.delete(cursorlessSubjectKey)
      entry.seen.add(cursorKey)
      entry.seen.add(cursorSubjectKey)
      trimSeen(entry.seen)
      return false
    }
    entry.seen.add(cursorKey)
    entry.seen.add(cursorSubjectKey)
  } else {
    if (
      entry.seen.has(cursorlessSubjectKey) ||
      entry.seen.has(cursorSubjectKey) ||
      (notificationKey !== null && entry.seen.has(notificationKey))
    ) {
      return false
    }
    entry.seen.add(cursorlessSubjectKey)
    if (notificationKey !== null) {
      entry.seen.add(notificationKey)
    }
  }
  trimSeen(entry.seen)
  return true
}

function trimSeen(seen: Set<string>): void {
  while (seen.size > SEEN_KEY_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest === undefined) {
      return
    }
    seen.delete(oldest)
  }
}

export function createRemoteForgeInboxSubscriptions(
  deliver: (environmentId: string, event: RemoteForgeEvent) => void,
  initialFailure: (environmentId: string) => void
) {
  const entries = new Map<string, RemoteForgeInboxSubscription>()
  // Why: method_not_found outlives ordinary RPCs; only a new connection or re-registration retries.
  const unsupportedConnections = new WeakSet<RemoteRuntimeSharedControlConnection>()
  let stopped = false

  function detach(environmentId: string): void {
    const entry = entries.get(environmentId)
    if (!entry) {
      return
    }
    entries.delete(environmentId)
    entry.abort.abort()
    entry.subscription?.close()
  }

  function attach(environmentId: string, connection: RemoteRuntimeSharedControlConnection): void {
    if (
      stopped ||
      entries.get(environmentId)?.connection === connection ||
      unsupportedConnections.has(connection)
    ) {
      return
    }
    detach(environmentId)
    const entry: RemoteForgeInboxSubscription = {
      connection,
      abort: new AbortController(),
      subscription: null,
      ready: false,
      seen: new Set<string>()
    }
    entries.set(environmentId, entry)
    const current = () => !stopped && entries.get(environmentId) === entry
    void connection
      .subscribe<unknown>(
        'notifications.subscribe',
        { includeDesktopSuppressed: true },
        15_000,
        {
          onResponse: (response) => {
            if (!current()) {
              return
            }
            if (!response.ok) {
              const terminal = response.error.code === 'method_not_found'
              if (terminal) {
                unsupportedConnections.add(connection)
              }
              detach(environmentId)
              if (!terminal) {
                initialFailure(environmentId)
              }
              return
            }
            const value = response.result
            if (typeof value !== 'object' || value === null || !('type' in value)) {
              return
            }
            if (value.type === 'ready') {
              // Why: a peer that breaks the ready contract after being ready must not keep delivering.
              entry.ready = isReadyResult(value)
              return
            }
            if (value.type === 'end') {
              detach(environmentId)
              return
            }
            if (!entry.ready) {
              return
            }
            const event = parseRemoteForgeNotification(value)
            if (!event) {
              return
            }
            if (!claimAnnouncement(entry, event)) {
              return
            }
            deliver(environmentId, event)
          },
          onError: () => {
            entry.ready = false
          },
          onClose: () => detach(environmentId)
        },
        entry.abort.signal
      )
      .then((subscription) => {
        if (current()) {
          entry.subscription = subscription
        } else {
          subscription.close()
        }
      })
      .catch(() => {
        if (current()) {
          detach(environmentId)
          initialFailure(environmentId)
        }
      })
  }

  return {
    attach,
    detach,
    stop: () => {
      stopped = true
      for (const environmentId of entries.keys()) {
        detach(environmentId)
      }
    }
  }
}

let subscriptions: ReturnType<typeof createRemoteForgeInboxSubscriptions> | null = null

export function registerRemoteForgeInboxNotifications(
  deliver: (environmentId: string, event: RemoteForgeEvent) => void,
  initialFailure: (environmentId: string) => void,
  connections: Iterable<[string, RemoteRuntimeSharedControlConnection]>
): () => void {
  subscriptions?.stop()
  const owner = createRemoteForgeInboxSubscriptions(deliver, initialFailure)
  subscriptions = owner
  for (const [environmentId, connection] of connections) {
    owner.attach(environmentId, connection)
  }
  return () => {
    owner.stop()
    if (subscriptions === owner) {
      subscriptions = null
    }
  }
}

export function attachRemoteForgeInboxNotifications(
  environmentId: string,
  connection: RemoteRuntimeSharedControlConnection
): void {
  subscriptions?.attach(environmentId, connection)
}

export function detachRemoteForgeInboxNotifications(environmentId: string): void {
  subscriptions?.detach(environmentId)
}
