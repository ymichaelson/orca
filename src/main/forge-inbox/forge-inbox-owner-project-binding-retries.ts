import type { ForgeOwnerRunning } from './forge-inbox-owner-running'
import type { ForgeInboxOwnerServiceOptions } from './forge-inbox-owner-service-options'
import type { EnsureProjectBindingResult } from './forge-inbox-project-binding-reconcile'
import { listProjectBindings } from './forge-inbox-project-binding'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'

/** Repo removal leaves a retryable row when GitLab exceeds this budget. */
export const PROJECT_EVENT_REMOVE_BUDGET_MS = 8_000
const ROTATION_RETRY_DELAYS_MS = [30_000, 120_000]

type BindingRetryDeps = {
  getRunning: () => ForgeOwnerRunning | null
  track: <T>(task: Promise<T>) => Promise<T>
  reconcile: (state: ForgeOwnerRunning, repoId: string) => Promise<EnsureProjectBindingResult>
  onError: (error: unknown) => void
}

export function createForgeOwnerProjectBindingRetries(
  options: ForgeInboxOwnerServiceOptions,
  deps: BindingRetryDeps
) {
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function hasPendingRotation(state: ForgeOwnerRunning, repoId: string): boolean {
    const link = state.ledger.getProjectEventRepoLink(repoId)
    return link !== null && state.ledger.getProjectBinding(link.bindingId)?.rotationPending === true
  }

  function scheduleRotationRetry(state: ForgeOwnerRunning, repoId: string, attempt: number): void {
    const delay = ROTATION_RETRY_DELAYS_MS[attempt]
    if (
      delay === undefined ||
      deps.getRunning() !== state ||
      retryTimers.has(repoId) ||
      !hasPendingRotation(state, repoId)
    ) {
      return
    }
    const timer = setTimeout(() => {
      retryTimers.delete(repoId)
      if (deps.getRunning() !== state || !hasPendingRotation(state, repoId)) {
        return
      }
      void deps
        .track(deps.reconcile(state, repoId))
        .then((result) => {
          if (!result.ok && result.retryable) {
            scheduleRotationRetry(state, repoId, attempt + 1)
          }
        })
        .catch(deps.onError)
    }, delay)
    timer.unref?.()
    retryTimers.set(repoId, timer)
  }

  return {
    scheduleRotationRetry,
    cancelRetries(): void {
      for (const timer of retryTimers.values()) {
        clearTimeout(timer)
      }
      retryTimers.clear()
    },
    /** A failed removal leaves a link-less row; retry its cleanup once per owner open. */
    scheduleCleanup(state: ForgeOwnerRunning): void {
      const ctx = state.ledger.ledgerContext()
      for (const binding of listProjectBindings(ctx)) {
        if (
          binding.failure?.code === 'cleanup-failed' &&
          getProjectEventRepoLinkByBinding(ctx, binding.bindingId) === null
        ) {
          void deps
            .track(
              state.ledger.removeProjectBinding({
                bindingId: binding.bindingId,
                signal: AbortSignal.any([
                  state.abort.signal,
                  AbortSignal.timeout(PROJECT_EVENT_REMOVE_BUDGET_MS)
                ]),
                ...(options.projectBindingExec === undefined
                  ? {}
                  : { exec: options.projectBindingExec })
              })
            )
            .catch(deps.onError)
        }
      }
    }
  }
}
