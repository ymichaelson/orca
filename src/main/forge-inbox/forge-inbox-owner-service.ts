import { existsSync } from 'node:fs'
import {
  DEFAULT_FORGE_INBOX_CONFIG,
  FORGE_INBOX_CONFIG_SCHEMA_VERSION,
  type ForgeInboxConfigView
} from '../../shared/forge-inbox-config'
import type { ForgeInstanceScope } from '../../shared/forge-inbox-types'
import type {
  ForgeCommentApprovalOutcome,
  ForgeInboxPatchOutcome
} from '../../shared/forge-inbox-rpc-types'
import { approveAndPublishForgeComment } from './forge-inbox-comment-approval'
import type { ForgeInboxDiscuss } from './forge-inbox-discuss'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'
import type { ForgeInboxPatchProducer } from './forge-inbox-patch-produce'
import { previewForgeProposal } from './forge-inbox-proposal-preview'
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
import {
  forgeOwnerIdle,
  forgeOwnerStatus,
  type ForgeOwnerServicePhase as Phase
} from './forge-inbox-owner-service-status'

export type {
  ForgeAnalysisRunnerFactory,
  ForgeInboxOwnerServiceOptions
} from './forge-inbox-owner-service-options'

export type ForgeInboxOwnerService = ReturnType<typeof createForgeInboxOwnerService>

/**
 * The single owner-host service: one ledger, one listener, one worker, shared by every host shell.
 * With no ledger file it stays dormant: nothing is created or opened until the first config or
 * credential write, so a profile that never used the feature pays nothing.
 * It is one-shot: after stop() or a failed start()/first open every ledger-backed call throws
 * ForgeInboxOwnerNotRunningError and a new service must be created.
 */
export function createForgeInboxOwnerService(options: ForgeInboxOwnerServiceOptions) {
  let phase: Phase = 'new'
  let running: ForgeOwnerRunning | null = null
  let opening: Promise<ForgeOwnerRunning> | null = null
  let reconciling: Promise<void> = Promise.resolve()
  let stopping: Promise<void> | null = null
  const hints = createForgeOwnerHints()
  const dormantHostId = mintForgeHostId(options)
  let knownHostId = dormantHostId

  function reconcile(state: ForgeOwnerRunning): Promise<void> {
    const next = reconciling.then(() => state.listener.reconcile())
    reconciling = next.catch(() => undefined)
    return next
  }

  // A failing open and a concurrent stop share one teardown so the ledger closes exactly once.
  function teardown(state: ForgeOwnerRunning): Promise<void> {
    state.closing ??= closeForgeOwnerRunning(state, reconciling)
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
        hints.end('open-failed')
        throw error
      }
      running = state
      hints.attach(state.ledger, knownHostId)
      knownHostId = state.ledger.hostId
      try {
        await reconcile(state)
        state.scheduler.wake()
        state.analysis?.wake()
        state.notifications?.wake()
      } catch (error) {
        phase = 'stopped'
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

  function dormantView(): ForgeInboxConfigView {
    return {
      hostId: dormantHostId,
      configRevision: 0,
      schemaVersion: FORGE_INBOX_CONFIG_SCHEMA_VERSION,
      config: structuredClone(DEFAULT_FORGE_INBOX_CONFIG),
      credentials: []
    }
  }

  async function start(): Promise<void> {
    if (phase !== 'new') {
      throw new ForgeInboxOwnerNotRunningError()
    }
    phase = 'running'
    if (existsSync(options.dbPath)) {
      await open()
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
        state.scheduler.wake()
        state.analysis?.wake()
      }
      return result
    },
    /** The durable owner id once a ledger opened; the pending one while dormant, so a stopped host can still name itself. */
    ownerHostId(): string {
      return knownHostId
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        const state = running
        phase = 'stopped'
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
      return running ? running.ledger.getConfig() : dormantView()
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
        state.scheduler.wake()
        state.analysis?.wake()
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
        state.scheduler.wake()
      }
      return result
    },
    async clearCredential(
      input: Parameters<ForgeInboxLedger['clearCredential']>[0],
      expectedOwner?: string
    ) {
      return fenced(running ?? (await ready()), expectedOwner).ledger.clearCredential(input)
    },
    /** Null while dormant: reading must not create a ledger, and there is nothing to preview yet. */
    getProposalPreview(scope: ForgeInstanceScope, proposalId: number) {
      const state = running
      const proposal = state?.ledger.getProposal(proposalId)
      if (!state || !proposal || !state.ledger.getItem(scope, proposal.itemId)) {
        return null
      }
      return previewForgeProposal(proposal)
    },
    /** Rejection is local state only: no network, no credential, and it never touches the project switch. */
    rejectProposal(
      scope: ForgeInstanceScope,
      proposalId: number
    ): { ok: true } | { ok: false; reason: 'not-found' | 'not-pending' } {
      const state = running
      const proposal = state?.ledger.getProposal(proposalId)
      if (!state || !proposal || !state.ledger.getItem(scope, proposal.itemId)) {
        return { ok: false as const, reason: 'not-found' as const }
      }
      const result = state.ledger.rejectProposal(proposalId)
      return result.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            reason: result.reason === 'not-pending' ? result.reason : 'not-found'
          }
    },
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
    async discuss(
      request: Parameters<ForgeInboxDiscuss>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ) {
      const state = fenced(running ?? (await ready()), expectedOwner)
      return state.discuss
        ? state.discuss(request, signal)
        : { kind: 'refused' as const, reason: 'host-unavailable' as const }
    },
    async proposePatch(
      request: Parameters<ForgeInboxPatchProducer>[0],
      signal: AbortSignal,
      expectedOwner?: string
    ): Promise<ForgeInboxPatchOutcome> {
      const state = fenced(running ?? (await ready()), expectedOwner)
      return state.proposePatch
        ? state.proposePatch(request, signal)
        : { kind: 'refused' as const, reason: 'host-unavailable' as const }
    },
    async settled(): Promise<void> {
      const state = running
      if (!state) {
        return
      }
      // The worker queues an analysis, so it settles first; analysis commits only wake itself.
      await state.scheduler.settled()
      await state.analysis?.settled()
    }
  }
}
