import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createForgeOwnerPatchApply } from './forge-inbox-owner-patch-apply'
import { createForgeOwnerPatchDiff } from './forge-inbox-owner-patch-diff'
import { createForgeOwnerPushApply } from './forge-inbox-owner-push-apply'
import { createForgeOwnerPushPropose } from './forge-inbox-owner-push-proposal'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service'
import { createForgeCommentBroker, type ForgeCommentBroker } from './forge-inbox-comment-broker'
import {
  getDispatchConfirmationSchedule,
  reconcileDispatchConfirmations
} from './forge-inbox-dispatch-confirmation-reconcile'
import { forgeErrorLabel } from './forge-inbox-error-label'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  createForgeNotificationProcessor,
  type ForgeNotificationProcessor
} from './forge-inbox-notification-processor'
import type { ForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import { createForgeOwnerListener } from './forge-inbox-owner-listener'
import { getProjectEventActionSchedule } from './forge-inbox-project-event-action'
import {
  drainProjectEventActions,
  type ProjectEventActionDeps
} from './forge-inbox-project-event-action-drain'
import { getProjectEventDecisionSchedule } from './forge-inbox-project-event-decision'
import { drainProjectEventDecisions } from './forge-inbox-project-event-decision-drain'
import { listOpenRunCancelRequests } from './forge-inbox-project-event-run-cancel-state'
import { listOpenTerminalRuns } from './forge-inbox-project-event-run-terminal-state'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'
import { createForgeWorkerScheduler } from './forge-inbox-worker-scheduler'
import type {
  ForgeProjectEventAgentLaunchOpener,
  ProjectEventAgentLaunch
} from './forge-inbox-project-event-agent-launch'

export type ForgeOwnerRunning = {
  ledger: ForgeInboxLedger
  listener: ReturnType<typeof createForgeOwnerListener>
  /** Exists only when the host wired a decision client; without one a binding delivery stays pending. */
  decisions: ReturnType<typeof createForgeWorkerScheduler> | null
  /** Executes the actions this build wires; an action with no executor stays queued. */
  actions: ReturnType<typeof createForgeWorkerScheduler>
  /** Exists only when the host can read GitLab; without one a dispatch's effects stay unconfirmed. */
  confirmations: ReturnType<typeof createForgeWorkerScheduler> | null
  /** Exists only when a sink asked for notifications, so an unwatched ledger is never claimed from. */
  notifications: ForgeNotificationProcessor | null
  /** The only holder of the GitLab write credential; approvals reach GitLab through it. */
  comments: ForgeCommentBroker
  /** Exists only when the host can prove a session record; without one Discuss is refused. */
  discuss: ForgeInboxDiscuss | null
  /** Exists only when the host can run a protected turn; without one proposals are refused. */
  proposePatch: ForgeInboxPatchProducer | null
  /** Approves a shown patch and builds it in a private directory; never pushes. */
  patchApply: ReturnType<typeof createForgeOwnerPatchApply>
  /** Renders the exact diff approval will apply, from the base pinned in the manifest. */
  patchDiff: ReturnType<typeof createForgeOwnerPatchDiff>
  /** Builds a push plan over the exact applied patch; the plan stays local until approved. */
  pushPropose: ReturnType<typeof createForgeOwnerPushPropose>
  /** Pushes one approved plan through a sealed bare repository; never merges. */
  pushApply: ReturnType<typeof createForgeOwnerPushApply>
  abort: AbortController
  /** Each launch a dispatch built is stopped here as soon as close begins; close waits for those stops. */
  launches: Promise<void>[]
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
  let networkIsReady = options.networkReady === undefined
  const ready = (options.networkReady ?? Promise.resolve())
    .catch((error: unknown) =>
      console.warn('[forge-inbox] network readiness failed', forgeErrorLabel(error))
    )
    .then(() => {
      networkIsReady = true
    })
  const aborted = new Promise<void>((resolve) =>
    abort.signal.addEventListener('abort', () => resolve(), { once: true })
  )
  // Gates every drain that talks to GitLab; a rejected readiness counts as ready so the inbox never wedges.
  const whenReady = async (): Promise<boolean> => {
    if (!networkIsReady) {
      await Promise.race([ready, aborted])
    }
    return !abort.signal.aborted
  }
  const launchAgentFactory = options.launchProjectEventAgent
  const launches: Promise<void>[] = []
  /**
   * The launch runs until close: stopping it at construction would end the dispatch it was built for.
   * Close aborts this owner, and every launch registered here stops and disposes then.
   */
  const stopAtClose = (launch: ProjectEventAgentLaunch): Promise<void> =>
    new Promise<void>((resolve) => {
      const end = (): void => {
        resolve(
          Promise.resolve()
            .then(() => launch.stop?.())
            .catch((error: unknown) =>
              console.warn('[forge-inbox] a launch did not stop', forgeErrorLabel(error))
            )
            .then(() => launch.dispose?.())
        )
      }
      if (abort.signal.aborted) {
        end()
        return
      }
      abort.signal.addEventListener('abort', end, { once: true })
    })
  // Every launch this owner's dispatches build is fenced here the moment it exists.
  const openLaunch: ForgeProjectEventAgentLaunchOpener = (factory, openedBy) => {
    const launch = factory(openedBy)
    launches.push(stopAtClose(launch))
    return launch
  }
  const wakeAll = (): void => {
    decisions?.wake()
    actions.wake()
    confirmations?.wake()
  }
  /**
   * Work left open by an earlier process has no dispatch of its own to ride, so the launch that
   * delivers it is built here: a committed stop, or a terminal whose exit is still unwatched.
   */
  const replayCommittedStops = (): void => {
    if (!launchAgentFactory) {
      return
    }
    const orphaned =
      listOpenRunCancelRequests(ledger.ledgerContext(), { replay: true }).length +
      listOpenTerminalRuns(ledger.ledgerContext()).length
    if (orphaned === 0) {
      return
    }
    openLaunch(launchAgentFactory, ledger)
  }
  const decideProjectEvent = options.decideProjectEvent
  const decisions =
    decideProjectEvent === undefined
      ? null
      : createForgeWorkerScheduler({
          readSchedule: () => getProjectEventDecisionSchedule(ledger.ledgerContext()),
          drain: async (stopping) => {
            if (!(await whenReady())) {
              return
            }
            await drainProjectEventDecisions(ledger.ledgerContext(), decideProjectEvent, stopping)
          },
          now: () => ledger.nowMs(),
          onError: (error) =>
            console.warn('[forge-inbox] project event decision failed', forgeErrorLabel(error))
        })
  const actionDeps: ProjectEventActionDeps = {
    limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
    launchAgentLedger: ledger,
    launchAgentOpener: openLaunch,
    ...(launchAgentFactory ? { launchAgentFactory } : {}),
    ...(options.observeProjectEventContext
      ? { observeContext: options.observeProjectEventContext(ledger) }
      : {})
  }
  const actions = createForgeWorkerScheduler({
    readSchedule: () => getProjectEventActionSchedule(ledger.ledgerContext()),
    drain: async (stopping) => {
      if (!(await whenReady())) {
        return
      }
      await drainProjectEventActions(ledger.ledgerContext(), actionDeps, stopping)
    },
    now: () => ledger.nowMs(),
    onError: (error) =>
      console.warn('[forge-inbox] project event action failed', forgeErrorLabel(error))
  })
  const createReader = options.createProjectEventDispatchReader
  const confirmations = createReader
    ? createForgeWorkerScheduler({
        readSchedule: () => getDispatchConfirmationSchedule(ledger.ledgerContext()),
        drain: async (stopping) => {
          if (!(await whenReady())) {
            return
          }
          return reconcileDispatchConfirmations(ledger.ledgerContext(), { createReader }, stopping)
        },
        now: () => ledger.nowMs(),
        onError: (error) =>
          console.warn('[forge-inbox] dispatch confirmation failed', forgeErrorLabel(error))
      })
    : null
  if (decisions) {
    ledger.onCommitted(() => decisions.wake())
  }
  ledger.onCommitted(() => actions.wake())
  if (confirmations) {
    ledger.onCommitted(() => confirmations.wake())
  }
  const listener = createForgeOwnerListener(
    ledger,
    { ...options.ingress, onAdmitted: () => wakeAll() },
    options.receiverSettings
  )
  const sinks = options.notificationSinks ?? []
  const notifications = sinks.length > 0 ? createForgeNotificationProcessor(ledger, sinks) : null
  const comments = createForgeCommentBroker({ ledger, http: options.http })
  const patchApply = createForgeOwnerPatchApply({
    ledger,
    http: options.http,
    signal: abort.signal,
    parentDirectory: join(dirname(options.dbPath), 'forge-inbox-patch-work')
  })
  const patchDiff = createForgeOwnerPatchDiff({
    ledger,
    http: options.http,
    signal: abort.signal
  })
  const pushPropose = createForgeOwnerPushPropose({
    ledger,
    http: options.http,
    signal: abort.signal
  })
  const pushApply = createForgeOwnerPushApply({
    ledger,
    http: options.http,
    signal: abort.signal,
    parentDirectory: join(dirname(options.dbPath), 'forge-inbox-push-work')
  })
  replayCommittedStops()
  return {
    ledger,
    listener,
    decisions,
    actions,
    confirmations,
    notifications,
    comments,
    discuss: null,
    proposePatch: null,
    patchApply,
    patchDiff,
    pushPropose,
    pushApply,
    abort,
    launches,
    closing: null
  }
}

/**
 * Admission is fenced and API work cancelled synchronously, before any wait, so a hung listener
 * close or a blocked reconcile can never leave a worker writing or a port binding; the ledger
 * closes only after the reconcile, the listener and the worker have all settled.
 */
export async function closeForgeOwnerRunning(
  state: ForgeOwnerRunning,
  reconciled: Promise<void>,
  pendingWork?: Promise<void>
): Promise<void> {
  const listenerStopped = state.listener.stop()
  const deciding = state.decisions?.stop()
  const acting = state.actions.stop()
  const confirming = state.confirmations?.stop()
  const published = state.notifications?.stop()
  // Fenced before any wait, so a launch or stop in flight cannot act after the owner began closing.
  state.abort.abort()
  const settled = await Promise.allSettled([
    reconciled,
    listenerStopped,
    deciding,
    acting,
    confirming,
    published,
    pendingWork,
    ...state.launches
  ])
  state.ledger.close()
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
}
