import { existsSync } from 'node:fs'
import { forgeErrorLabel } from './forge-inbox-error-label'
import type { ForgeInboxConfigView } from '../../shared/forge-inbox-config'
import type {
  ForgeCommentApprovalOutcome,
  ForgeItemMergeOutcome
} from '../../shared/forge-inbox-rpc-types'
import { approveAndPublishForgeComment } from './forge-inbox-comment-approval'
import { mergeForgeItem } from './forge-inbox-item-merge'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'
import { createForgeOwnerActions } from './forge-inbox-owner-actions'
import { createForgeOwnerProposalActions } from './forge-inbox-owner-proposal-actions'
import {
  ForgeInboxOwnerMismatchError,
  ForgeInboxOwnerNotRunningError
} from './forge-inbox-owner-errors'
import { ackForgeClientCursor, createForgeOwnerCursorReads } from './forge-inbox-owner-cursors'
import { createForgeOwnerHints } from './forge-inbox-owner-hints'
import { createForgeOwnerReads } from './forge-inbox-owner-reads'
import {
  closeForgeOwnerRunning,
  mintForgeHostId,
  openForgeOwnerRunning,
  type ForgeOwnerRunning
} from './forge-inbox-owner-running'
import { forgeOwnerDormantView } from './forge-inbox-owner-dormant-view'
import { createForgeOwnerProjectEvents } from './forge-inbox-owner-project-events'
import { recoverRunsOnOpen } from './forge-inbox-project-event-run-recovery-startup'
import {
  forgeOwnerIdle,
  forgeOwnerStatus,
  type ForgeOwnerServicePhase as Phase
} from './forge-inbox-owner-service-status'

export type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'

export type ForgeInboxOwnerService = ReturnType<typeof createForgeInboxOwnerService>

/** One-shot host owner; an unused profile stays dormant until receiver enable or a domain write. */
export function createForgeInboxOwnerService(options: ForgeInboxOwnerServiceOptions) {
  let phase: Phase = 'new'
  let running: ForgeOwnerRunning | null = null
  let opening: Promise<ForgeOwnerRunning> | null = null
  let reconciling: Promise<void> = Promise.resolve()
  let stopping: Promise<void> | null = null
  let bindingsWork: Promise<void> = Promise.resolve()
  const hints = createForgeOwnerHints()
  const dormantHostId = mintForgeHostId(options)
  let knownHostId = dormantHostId
  let unsubscribeReceiver: (() => void) | undefined

  function detachReceiver(): void {
    unsubscribeReceiver?.()
    unsubscribeReceiver = undefined
  }

  function trackBindings<T>(task: Promise<T>): Promise<T> {
    const settled = task.then(
      () => undefined,
      () => undefined
    )
    bindingsWork = Promise.all([bindingsWork, settled]).then(() => undefined)
    return task
  }

  const projectEvents = createForgeOwnerProjectEvents(options, {
    isRunning: () => phase === 'running',
    getRunning: () => running,
    runningFor: (expectedOwner) => (running ? fenced(running, expectedOwner) : null),
    stateFor: async (expectedOwner) => fenced(running ?? (await ready()), expectedOwner),
    ready,
    reconcile,
    track: trackBindings
  })

  function reconcile(state: ForgeOwnerRunning): Promise<void> {
    const next = reconciling.then(() => {
      if (phase === 'running') {
        state.ledger.getConfig()
      }
      return state.listener.reconcile()
    })
    reconciling = next.catch(() => undefined)
    return next
  }

  // A failing open and a concurrent stop share one teardown so the ledger closes exactly once.
  function teardown(state: ForgeOwnerRunning): Promise<void> {
    state.closing ??= closeForgeOwnerRunning(state, reconciling, bindingsWork)
    return state.closing
  }

  /** Serialized and final on failure: concurrent first writes share one open. */
  function open(): Promise<ForgeOwnerRunning> {
    if (running) {
      return Promise.resolve(running)
    }
    if (phase !== 'running') {
      return Promise.reject(new ForgeInboxOwnerNotRunningError())
    }
    opening ??= (async () => {
      let state: ForgeOwnerRunning
      try {
        state = openForgeOwnerRunning(
          options,
          existsSync(options.dbPath) ? options.hostId : dormantHostId
        )
      } catch (error) {
        phase = 'stopped'
        detachReceiver()
        hints.end('open-failed')
        throw error
      }
      running = state
      hints.attach(state.ledger, knownHostId)
      knownHostId = state.ledger.hostId
      try {
        if (options.recoverProjectEventRuns) {
          await recoverRunsOnOpen(options, state.ledger)
        }
        await reconcile(state)
        state.decisions?.wake()
        state.actions.wake()
        state.confirmations?.wake()
        state.notifications?.wake()
        projectEvents.bindings.scheduleEnabled(state)
      } catch (error) {
        phase = 'stopped'
        detachReceiver()
        running = null
        hints.end('open-failed')
        await teardown(state)
        throw error
      }
      return state
    })()
    return opening
  }

  /** A stop that landed while the open was reconciling must not let the caller use a closed ledger. */
  async function ready(): Promise<ForgeOwnerRunning> {
    const state = await open()
    if (running !== state) {
      throw new ForgeInboxOwnerNotRunningError()
    }
    return state
  }

  /** After a lazy open and before any write: a ledger that appeared later may carry another owner id. */
  function fenced(state: ForgeOwnerRunning, expectedOwner: string | undefined): ForgeOwnerRunning {
    if (expectedOwner !== undefined && state.ledger.hostId !== expectedOwner) {
      throw new ForgeInboxOwnerMismatchError()
    }
    return state
  }

  async function start(): Promise<void> {
    if (phase !== 'new') {
      throw new ForgeInboxOwnerNotRunningError()
    }
    phase = 'running'
    try {
      unsubscribeReceiver = projectEvents.subscribeReceiver((error) => {
        if (phase === 'running') {
          console.warn('[forge-inbox] receiver reconcile failed', forgeErrorLabel(error))
        }
      })
      if (existsSync(options.dbPath) || options.receiverSettings?.read()?.enabled) {
        await open()
      }
    } catch (error) {
      detachReceiver()
      phase = 'stopped'
      throw error
    }
  }

  const reads = createForgeOwnerReads(() => {
    if (phase !== 'running') {
      throw new ForgeInboxOwnerNotRunningError()
    }
    return running?.ledger ?? null
  })

  const cursorReads = createForgeOwnerCursorReads(() => {
    if (phase !== 'running') {
      throw new ForgeInboxOwnerNotRunningError()
    }
    return running?.ledger ?? null
  })

  const proposalActions = createForgeOwnerProposalActions(() => running?.ledger ?? null)
  const actions = createForgeOwnerActions(async (expectedOwner) =>
    fenced(running ?? (await ready()), expectedOwner)
  )

  return {
    start,
    ...reads,
    ...cursorReads,
    subscribeChangeHints(listener: Parameters<typeof hints.subscribe>[0]) {
      if (phase !== 'running') {
        throw new ForgeInboxOwnerNotRunningError()
      }
      return hints.subscribe(listener)
    },
    /** Trusted reader id from the transport context, never a wire parameter. */
    async ackClientCursor(
      input: Parameters<typeof ackForgeClientCursor>[1],
      expectedOwner?: string
    ): Promise<number> {
      if (phase !== 'running') {
        throw new ForgeInboxOwnerNotRunningError()
      }
      return ackForgeClientCursor(running ? fenced(running, expectedOwner).ledger : null, input)
    },
    async updateProjectPolicy(
      expectedRevision: number,
      input: Parameters<ForgeInboxLedger['updateProjectPolicy']>[1],
      expectedOwner?: string
    ) {
      const state = fenced(running ?? (await ready()), expectedOwner)
      const result = state.ledger.updateProjectPolicy(expectedRevision, input)
      if (result.ok && result.configRevision !== expectedRevision) {
        await reconcile(state)
      }
      return result
    },
    ...projectEvents.actions,
    /** The durable owner id once a ledger opened; the pending one while dormant, so a stopped host can still name itself. */
    ownerHostId(): string {
      return knownHostId
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        const state = running
        phase = 'stopped'
        detachReceiver()
        projectEvents.cancelRetries()
        running = null
        hints.end('stopped')
        if (state) {
          await teardown(state)
        }
      })()
      return stopping
    },
    /** Dormant (no file yet): the default view, without creating anything. */
    getConfig(): ForgeInboxConfigView {
      if (phase !== 'running') {
        throw new ForgeInboxOwnerNotRunningError()
      }
      return running ? running.ledger.getConfig() : forgeOwnerDormantView(dormantHostId)
    },
    status() {
      return forgeOwnerStatus(phase, running)
    },
    idle(): boolean {
      return forgeOwnerIdle(running)
    },
    async updateConfig(expectedRevision: number, config: unknown, expectedOwner?: string) {
      const state = fenced(running ?? (await ready()), expectedOwner)
      const result = state.ledger.updateConfig(expectedRevision, config)
      if (result.ok) {
        await reconcile(state)
      }
      return result
    },
    async setCredential(
      input: Parameters<ForgeInboxLedger['setCredential']>[0],
      expectedOwner?: string
    ) {
      const state = fenced(running ?? (await ready()), expectedOwner)
      const result = state.ledger.setCredential(input)
      if (result.ok && input.kind === 'api-read') {
        state.actions.wake()
      }
      return result
    },
    async clearCredential(
      input: Parameters<ForgeInboxLedger['clearCredential']>[0],
      expectedOwner?: string
    ) {
      return fenced(running ?? (await ready()), expectedOwner).ledger.clearCredential(input)
    },
    ...proposalActions,
    ...actions,
    async approveComment(
      input: Parameters<typeof approveAndPublishForgeComment>[1],
      signal: AbortSignal,
      expectedOwner?: string
    ): Promise<ForgeCommentApprovalOutcome> {
      const state = fenced(running ?? (await ready()), expectedOwner)
      return approveAndPublishForgeComment(
        { ledger: state.ledger, broker: state.comments },
        input,
        signal
      )
    },
    /** A person confirmed the run's recommendation, so the host merges exactly the reviewed head. */
    async mergeItem(
      input: Parameters<typeof mergeForgeItem>[1],
      signal: AbortSignal,
      expectedOwner?: string
    ): Promise<ForgeItemMergeOutcome> {
      const state = fenced(running ?? (await ready()), expectedOwner)
      return mergeForgeItem({ ledger: state.ledger, merge: state.comments.merge }, input, signal)
    },
    async settled(): Promise<void> {
      const state = running
      if (!state) {
        return
      }
      // Each drain settles in turn; a commit only wakes the drains that follow it.
      await state.decisions?.settled()
      await state.actions.settled()
      await state.confirmations?.settled()
      await bindingsWork
    }
  }
}
