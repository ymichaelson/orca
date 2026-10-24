import { randomUUID } from 'node:crypto'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service'
import { createForgeAnalysisProposal } from './forge-inbox-analysis-proposal'
import { createForgeAnalysisScheduler } from './forge-inbox-analysis-scheduler'
import { createForgeCommentBroker, type ForgeCommentBroker } from './forge-inbox-comment-broker'
import { createForgeInboxCoordinator } from './forge-inbox-coordinator'
import { forgeErrorLabel } from './forge-inbox-error-label'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createForgeNotificationProcessor,
  type ForgeNotificationProcessor
} from './forge-inbox-notification-processor'
import type { ForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import { createForgeOwnerListener } from './forge-inbox-owner-listener'
import {
  createForgeWebhookWorker,
  FORGE_WEBHOOK_MAX_DELIVERIES_PER_DRAIN
} from './forge-inbox-webhook-worker'
import { createForgeWorkerScheduler } from './forge-inbox-worker-scheduler'

export type ForgeOwnerRunning = {
  ledger: ForgeInboxLedger
  listener: ReturnType<typeof createForgeOwnerListener>
  scheduler: ReturnType<typeof createForgeWorkerScheduler>
  /** Exists only when the host wired an analysis adapter; without one queued runs stay queued. */
  analysis: ReturnType<typeof createForgeAnalysisScheduler> | null
  /** Exists only when a sink asked for notifications, so an unwatched ledger is never claimed from. */
  notifications: ForgeNotificationProcessor | null
  /** The only holder of the GitLab write credential; approvals reach GitLab through it. */
  comments: ForgeCommentBroker
  /** Exists only when the host can prove a session record; without one Discuss is refused. */
  discuss: ForgeInboxDiscuss | null
  /** Exists only when the host can run a protected turn; without one proposals are refused. */
  proposePatch: ForgeInboxPatchProducer | null
  abort: AbortController
  closing: Promise<void> | null
}

/** Host id a not-yet-created ledger will mint, so a dormant view and the later file agree. */
export function mintForgeHostId(options: ForgeInboxOwnerServiceOptions): string {
  return options.hostId ?? randomUUID()
}

/** Opens the ledger and wires the worker, scheduler and listener around it; a throw leaves nothing open. */
export function openForgeOwnerRunning(
  options: ForgeInboxOwnerServiceOptions,
  hostId: string | undefined
): ForgeOwnerRunning {
  const ledger = ForgeInboxLedger.open(options.dbPath, {
    ...(hostId === undefined ? {} : { hostId }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.secretStore ? { secretStore: options.secretStore } : {})
  })
  const abort = new AbortController()
  const worker = createForgeWebhookWorker({ ledger, http: options.http, signal: abort.signal })
  let networkIsReady = options.networkReady === undefined
  const networkReady = (options.networkReady ?? Promise.resolve())
    .catch((error: unknown) =>
      console.warn('[forge-inbox] network readiness failed', forgeErrorLabel(error))
    )
    .then(() => {
      networkIsReady = true
    })
  const aborted = new Promise<void>((resolve) =>
    abort.signal.addEventListener('abort', () => resolve(), { once: true })
  )
  const scheduler = createForgeWorkerScheduler({
    readSchedule: () => ledger.getWebhookWorkSchedule(),
    drain: async () => {
      if (!networkIsReady) {
        await Promise.race([networkReady, aborted])
      }
      if (abort.signal.aborted) {
        return { capped: false }
      }
      return {
        capped: (await worker.drainOnce()).processed >= FORGE_WEBHOOK_MAX_DELIVERIES_PER_DRAIN
      }
    },
    now: () => ledger.nowMs(),
    onError: (error) => console.warn('[forge-inbox] worker drain failed', forgeErrorLabel(error))
  })
  const listener = createForgeOwnerListener(ledger, {
    ...options.ingress,
    onAdmitted: () => scheduler.wake()
  })
  const sinks = options.notificationSinks ?? []
  const notifications = sinks.length > 0 ? createForgeNotificationProcessor(ledger, sinks) : null
  const analysis = createAnalysisScheduler(ledger, options)
  const comments = createForgeCommentBroker({ ledger, http: options.http })
  const discuss = options.discuss?.(ledger) ?? null
  const proposePatch = options.proposePatch?.(ledger) ?? null
  return {
    ledger,
    listener,
    scheduler,
    analysis,
    notifications,
    comments,
    discuss,
    proposePatch,
    abort,
    closing: null
  }
}

/**
 * Runs whatever claims a paid analysis. Every commit wakes it: a run is queued by a worker
 * transaction, not by a call on this service.
 */
function createAnalysisScheduler(
  ledger: ForgeInboxLedger,
  options: ForgeInboxOwnerServiceOptions
): ForgeOwnerRunning['analysis'] {
  const analyse = options.analyse?.(ledger)
  if (!analyse) {
    return null
  }
  const coordinator = createForgeInboxCoordinator({
    ledger,
    scope: {},
    analyse,
    proposeComment: createForgeAnalysisProposal(ledger)
  })
  const scheduler = createForgeAnalysisScheduler({
    drain: async (stopping) => {
      await coordinator.drainOnce(stopping)
    },
    onError: (error) => console.warn('[forge-inbox] analysis drain failed', forgeErrorLabel(error))
  })
  ledger.onCommitted(() => scheduler.wake())
  return scheduler
}

/**
 * Admission is fenced and API work cancelled synchronously, before any wait, so a hung listener
 * close or a blocked reconcile can never leave a worker writing or a port binding; the ledger
 * closes only after the reconcile, the listener and the worker have all settled.
 */
export async function closeForgeOwnerRunning(
  state: ForgeOwnerRunning,
  reconciled: Promise<void>
): Promise<void> {
  const listenerStopped = state.listener.stop()
  const drained = state.scheduler.stop()
  const analysing = state.analysis?.stop()
  const published = state.notifications?.stop()
  state.abort.abort()
  const settled = await Promise.allSettled([
    reconciled,
    listenerStopped,
    drained,
    analysing,
    published
  ])
  state.ledger.close()
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
}
