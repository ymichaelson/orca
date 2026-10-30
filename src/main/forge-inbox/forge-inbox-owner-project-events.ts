import {
  normalizeProjectEventReceiverSettings,
  receiverBaseUrl
} from '../../shared/project-event-receiver-settings'
import { forgeErrorLabel } from './forge-inbox-error-label'
import { ForgeInboxOwnerNotRunningError } from './forge-inbox-owner-errors'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'
import type { ForgeOwnerRunning } from './forge-inbox-owner-running'
import type { ProjectBindingContext } from './forge-inbox-project-binding-context'
import { createLoopbackProjectEventProbe } from './forge-inbox-project-binding-probe'
import type { EnsureProjectBindingResult } from './forge-inbox-project-binding-reconcile'
import {
  createForgeOwnerProjectBindingRetries,
  PROJECT_EVENT_REMOVE_BUDGET_MS
} from './forge-inbox-owner-project-binding-retries'
import type { ProjectEventQuestionStatus } from '../../shared/forge-inbox-project-event-question'
import type { ProjectEventActivityView } from '../../shared/forge-inbox-project-event-activity'
import {
  answerProjectEventQuestion,
  listProjectEventQuestions
} from './forge-inbox-project-event-question-answer'

export type ProjectBindingScheduler = {
  reconcile: (state: ForgeOwnerRunning, repoId: string) => Promise<EnsureProjectBindingResult>
  schedule: (state: ForgeOwnerRunning, repoId: string) => void
  scheduleEnabled: (state: ForgeOwnerRunning) => void
}

type ProjectEventDeps = {
  isRunning: () => boolean
  getRunning: () => ForgeOwnerRunning | null
  runningFor: (expectedOwner: string | undefined) => ForgeOwnerRunning | null
  stateFor: (expectedOwner: string | undefined) => Promise<ForgeOwnerRunning>
  ready: () => Promise<ForgeOwnerRunning>
  reconcile: (state: ForgeOwnerRunning) => Promise<void>
  track: <T>(task: Promise<T>) => Promise<T>
}

/** Reconcile and policy commands share the owner's open state, so they live together. */
export function createForgeOwnerProjectEvents(
  options: ForgeInboxOwnerServiceOptions,
  deps: ProjectEventDeps
) {
  const loopbackProbe = createLoopbackProjectEventProbe(options.receiverSettings)
  const missingRepo: ProjectBindingContext = {
    ok: false,
    code: 'repo-not-found',
    retryable: false
  }
  const repoWork = new Map<string, Promise<void>>()
  const { scheduleCleanup, scheduleRotationRetry, cancelRetries } =
    createForgeOwnerProjectBindingRetries(options, {
      getRunning: deps.getRunning,
      track: deps.track,
      reconcile: reconcileBinding,
      onError: warnBindingFailure
    })

  function serializeRepo<T>(repoId: string, task: () => Promise<T>): Promise<T> {
    const previous = repoWork.get(repoId) ?? Promise.resolve()
    const run = previous.then(task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    repoWork.set(repoId, tail)
    return run.finally(() => {
      if (repoWork.get(repoId) === tail) {
        repoWork.delete(repoId)
      }
    })
  }

  async function reconcileBindingOnce(
    state: ForgeOwnerRunning,
    repoId: string,
    allowUnprotectedStorage?: boolean
  ): Promise<EnsureProjectBindingResult> {
    const context = (options.resolveProjectBindingContext ?? (() => missingRepo))(repoId)
    if (!context.ok) {
      return { ok: false, binding: null, code: context.code, retryable: false }
    }
    const baseUrl = receiverBaseUrl(
      normalizeProjectEventReceiverSettings(options.receiverSettings?.read())
    )
    if (baseUrl === null) {
      return { ok: false, binding: null, code: 'receiver-not-configured', retryable: false }
    }
    return state.ledger.ensureProjectBinding({
      repoPath: context.repoPath,
      repoId,
      connectionId: context.connectionId,
      explicitProjectRefText: context.explicitProjectRefText,
      receiverBaseUrl: baseUrl,
      allowUnprotectedStorage,
      ...(options.projectBindingExec === undefined ? {} : { exec: options.projectBindingExec }),
      probe: options.probeProjectEventBinding ?? loopbackProbe,
      signal: state.abort.signal
    })
  }

  function reconcileBinding(
    state: ForgeOwnerRunning,
    repoId: string,
    allowUnprotectedStorage?: boolean
  ): Promise<EnsureProjectBindingResult> {
    return serializeRepo(repoId, () => reconcileBindingOnce(state, repoId, allowUnprotectedStorage))
  }

  function warnBindingFailure(error: unknown): void {
    if (deps.isRunning()) {
      console.warn('[forge-inbox] project binding reconcile failed', forgeErrorLabel(error))
    }
  }

  function schedule(state: ForgeOwnerRunning, repoId: string): void {
    if (state.ledger.getProjectEventPolicy(repoId)?.enabled !== true) {
      return
    }
    void deps.track(reconcileBinding(state, repoId)).catch(warnBindingFailure)
  }

  function scheduleEnabled(state: ForgeOwnerRunning): void {
    scheduleCleanup(state)
    for (const policy of state.ledger.listProjectEventPolicies()) {
      if (policy.enabled) {
        void deps.track(reconcileBinding(state, policy.repoId)).catch(warnBindingFailure)
      }
    }
  }

  async function reconcileReceiverSettings(): Promise<void> {
    if (!deps.isRunning()) {
      throw new ForgeInboxOwnerNotRunningError()
    }
    const state =
      deps.getRunning() ?? (options.receiverSettings?.read()?.enabled ? await deps.ready() : null)
    if (state) {
      await deps.reconcile(state)
      scheduleEnabled(state)
    }
  }

  const bindings: ProjectBindingScheduler = {
    reconcile: reconcileBinding,
    schedule,
    scheduleEnabled
  }

  return {
    bindings,
    cancelRetries,
    subscribeReceiver(onError: (error: unknown) => void): (() => void) | undefined {
      return options.receiverSettings?.subscribe(() => {
        if (deps.isRunning()) {
          void reconcileReceiverSettings().catch(onError)
        }
      })
    },
    actions: {
      reconcileReceiverSettings,
      /** No ledger open for a read: a never-configured host answers null without creating a file. */
      getProjectEventPolicy(repoId: string, expectedOwner?: string) {
        if (!deps.isRunning()) {
          throw new ForgeInboxOwnerNotRunningError()
        }
        const state = deps.runningFor(expectedOwner)
        return state ? state.ledger.getProjectEventPolicy(repoId) : null
      },
      getProjectEventBinding(repoId: string, expectedOwner?: string) {
        if (!deps.isRunning()) {
          throw new ForgeInboxOwnerNotRunningError()
        }
        const state = deps.runningFor(expectedOwner)
        if (!state) {
          return null
        }
        const link = state.ledger.getProjectEventRepoLink(repoId)
        return link ? state.ledger.getProjectBinding(link.bindingId) : null
      },
      /** A read with no ledger open: a stopped or unattached owner answers empty. */
      getProjectEventActivity(
        repoId: string,
        limit?: number,
        expectedOwner?: string
      ): ProjectEventActivityView {
        const empty: ProjectEventActivityView = { events: [], lastProcessed: null }
        if (!deps.isRunning()) {
          return empty
        }
        const state = deps.runningFor(expectedOwner)
        return state ? state.ledger.getProjectEventActivity(repoId, limit) : empty
      },
      async rotateProjectEventSecret(
        repoId: string,
        expectedOwner?: string,
        allowUnprotectedStorage?: boolean
      ) {
        const state = await deps.stateFor(expectedOwner)
        return deps.track(
          serializeRepo(repoId, async () => {
            const context = (options.resolveProjectBindingContext ?? (() => missingRepo))(repoId)
            if (!context.ok) {
              return { ok: false as const, binding: null, code: context.code, retryable: false }
            }
            const link = state.ledger.getProjectEventRepoLink(repoId)
            if (!link) {
              return {
                ok: false as const,
                binding: null,
                code: 'secret-unavailable',
                retryable: false
              }
            }
            const rotated = await state.ledger.rotateProjectBindingSecret({
              bindingId: link.bindingId,
              repoPath: context.repoPath,
              connectionId: context.connectionId,
              allowUnprotectedStorage,
              signal: state.abort.signal,
              ...(options.projectBindingExec === undefined
                ? {}
                : { exec: options.projectBindingExec })
            })
            if (!rotated.ok && rotated.retryable) {
              scheduleRotationRetry(state, repoId, 0)
            }
            if (rotated.ok && rotated.binding.state === 'failed') {
              return reconcileBindingOnce(state, repoId, allowUnprotectedStorage)
            }
            return rotated
          })
        )
      },
      /**
       * Deletes the repo's GitLab hook and link when the repo itself goes away. Disabling a policy
       * stays local-only, so this is called only from repo removal, never from a settings save.
       */
      async removeProjectEvent(
        repoId: string,
        expectedOwner?: string
      ): Promise<{ ok: true; removed: boolean } | { ok: false; code: string }> {
        const state = deps.isRunning() ? deps.runningFor(expectedOwner) : null
        if (!state) {
          return { ok: false, code: 'not-running' }
        }
        return deps.track(
          serializeRepo(repoId, async () => {
            const link = state.ledger.getProjectEventRepoLink(repoId)
            if (!link) {
              return { ok: true as const, removed: false }
            }
            const context = (options.resolveProjectBindingContext ?? (() => missingRepo))(repoId)
            const result = await state.ledger.removeProjectBinding({
              bindingId: link.bindingId,
              signal: AbortSignal.any([
                state.abort.signal,
                AbortSignal.timeout(PROJECT_EVENT_REMOVE_BUDGET_MS)
              ]),
              ...(context.ok
                ? { repoPath: context.repoPath, connectionId: context.connectionId }
                : {}),
              ...(options.projectBindingExec === undefined
                ? {}
                : { exec: options.projectBindingExec })
            })
            return result.ok
              ? { ok: true as const, removed: true }
              : { ok: false as const, code: result.code }
          })
        )
      },
      async updateProjectEventPolicy(
        repoId: string,
        expectedGeneration: number,
        patch: unknown,
        expectedOwner?: string
      ) {
        const state = await deps.stateFor(expectedOwner)
        const result = state.ledger.updateProjectEventPolicy(repoId, expectedGeneration, patch)
        // Why not await: identity and glab work after commit must never delay or fail the save.
        if (result.ok) {
          schedule(state, repoId)
        }
        return result
      },
      async retryProjectEvent(
        repoId: string,
        expectedOwner?: string,
        allowUnprotectedStorage?: boolean
      ) {
        const state = await deps.stateFor(expectedOwner)
        return deps.track(reconcileBinding(state, repoId, allowUnprotectedStorage))
      },
      /** A read: a host that never opened a ledger answers empty rather than creating a file. */
      listProjectEventQuestions(status?: ProjectEventQuestionStatus, expectedOwner?: string) {
        if (!deps.isRunning()) {
          throw new ForgeInboxOwnerNotRunningError()
        }
        const state = deps.runningFor(expectedOwner)
        return state
          ? listProjectEventQuestions(state.ledger.ledgerContext(), {
              ownerHostId: expectedOwner ?? state.ledger.hostId,
              ...(status === undefined ? {} : { status })
            })
          : []
      },
      async answerProjectEventQuestion(questionId: number, answer: string, expectedOwner?: string) {
        const state = await deps.stateFor(expectedOwner)
        return answerProjectEventQuestion(state.ledger.ledgerContext(), {
          ownerHostId: expectedOwner ?? state.ledger.hostId,
          questionId,
          answer
        })
      }
    }
  }
}
