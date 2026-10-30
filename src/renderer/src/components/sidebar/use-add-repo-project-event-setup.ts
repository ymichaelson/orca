import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { projectEventOwnerTarget } from '../settings/project-event-owner-scope'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { AddRepoProjectEventStepProps } from './AddRepoProjectEventStep'
import {
  detectProjectEventGitlabLink,
  type ProjectEventGitlabLink
} from './project-event-gitlab-link'

type CompleteGitRepoAdd = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId
) => Promise<void>

/** One import operation: its repos were added together and complete the add exactly once. */
export type GitRepoBatchHandoff = {
  repoIds: readonly string[]
  source: AddRepoExistingWorkspaceSource
  executionHostId?: ExecutionHostId
}

type HeldSetup = {
  repo: Repo
  target: RuntimeClientTarget | null
  source: AddRepoExistingWorkspaceSource
  executionHostId?: ExecutionHostId
  /** The first Git repo of the import, which the single final completion navigates to. */
  completionRepoId: string
}

/**
 * Sits between every Git add path and the final navigation: each GitLab-linked repo gets one step to
 * set up the project event agent, and the held completion runs exactly once when the last resolves.
 */
export function useAddRepoProjectEventSetup({
  completeGitRepoAdd,
  setStep
}: {
  completeGitRepoAdd: CompleteGitRepoAdd
  setStep: Dispatch<SetStateAction<AddRepoDialogStep>>
}): {
  onGitRepoReady: CompleteGitRepoAdd
  onGitRepoBatchReady: (handoff: GitRepoBatchHandoff) => Promise<void>
  step: AddRepoProjectEventStepProps | null
  /** Continues the held add without the event agent; false when no step is showing. */
  requestDismiss: () => boolean
  reset: () => void
} {
  const [pending, setPending] = useState<HeldSetup | null>(null)
  const pendingRef = useRef<HeldSetup | null>(null)
  const queueRef = useRef<HeldSetup[]>([])
  const epochRef = useRef(0)
  const detectingRef = useRef(false)
  const busyRef = useRef(false)
  const completionRef = useRef<'idle' | 'running' | 'done'>('idle')

  const holdQueue = useCallback(
    (steps: HeldSetup[]): void => {
      queueRef.current = steps
      pendingRef.current = steps[0] ?? null
      completionRef.current = 'idle'
      setPending(steps[0] ?? null)
      setStep('project-event')
    },
    [setStep]
  )

  /** Null means this entry completes immediately: no owner row, not a Git repo, or nothing to bind. */
  const heldSetupFor = useCallback(
    async (
      repoId: string,
      source: AddRepoExistingWorkspaceSource,
      executionHostId: ExecutionHostId | undefined,
      completionRepoId: string,
      repos: readonly Repo[]
    ): Promise<HeldSetup | null> => {
      // Why: without a host identity the owner row is ambiguous, so the add completes unguessed.
      const owners =
        executionHostId === undefined
          ? []
          : repos.filter((entry) => repoMatchesHostIdentity(entry, repoId, executionHostId))
      const repo = owners.length === 1 ? owners[0] : null
      // Why: a project created here has no remote yet, so there is nothing to bind.
      if (source === 'create_project' || !repo || !isGitRepoKind(repo)) {
        return null
      }
      const target = projectEventOwnerTarget(repo)
      const link: ProjectEventGitlabLink = await detectProjectEventGitlabLink(repo, target)
      return link === 'not-gitlab'
        ? null
        : { repo, target, source, executionHostId, completionRepoId }
    },
    []
  )

  const detectQueue = useCallback(
    async (
      repoIds: readonly string[],
      source: AddRepoExistingWorkspaceSource,
      executionHostId: ExecutionHostId | undefined,
      completionRepoId: string
    ): Promise<void> => {
      const epoch = epochRef.current
      // Why: one snapshot of the added rows, so a later store refresh cannot retarget a queued entry.
      const repos = useAppStore.getState().repos
      detectingRef.current = true
      const steps: HeldSetup[] = []
      try {
        for (const repoId of repoIds) {
          const held = await heldSetupFor(repoId, source, executionHostId, completionRepoId, repos)
          if (held) {
            steps.push(held)
          }
        }
      } finally {
        if (epochRef.current === epoch) {
          detectingRef.current = false
        }
      }
      // Why: a reset ended that dialog session, so its detection must not navigate or close a newer one.
      if (epochRef.current !== epoch) {
        return
      }
      if (steps.length === 0) {
        await completeGitRepoAdd(completionRepoId, source, executionHostId)
        return
      }
      holdQueue(steps)
    },
    [completeGitRepoAdd, heldSetupFor, holdQueue]
  )

  const claimed = useCallback(
    (): boolean => pendingRef.current !== null || detectingRef.current,
    []
  )

  const onGitRepoBatchReady = useCallback(
    async ({ repoIds, source, executionHostId }: GitRepoBatchHandoff): Promise<void> => {
      const completionRepoId = repoIds[0]
      if (completionRepoId === undefined) {
        return
      }
      if (claimed()) {
        await completeGitRepoAdd(completionRepoId, source, executionHostId)
        return
      }
      await detectQueue([...new Set(repoIds)], source, executionHostId, completionRepoId)
    },
    [claimed, completeGitRepoAdd, detectQueue]
  )

  const onGitRepoReady = useCallback<CompleteGitRepoAdd>(
    (repoId, source, executionHostId) =>
      onGitRepoBatchReady({ repoIds: [repoId], source, executionHostId }),
    [onGitRepoBatchReady]
  )

  const completeHeld = useCallback(
    async (held: HeldSetup): Promise<boolean> => {
      if (completionRef.current !== 'idle') {
        return false
      }
      const epoch = epochRef.current
      completionRef.current = 'running'
      try {
        await completeGitRepoAdd(held.completionRepoId, held.source, held.executionHostId)
        if (epochRef.current === epoch) {
          completionRef.current = 'done'
        }
        return true
      } catch (error) {
        if (epochRef.current === epoch) {
          completionRef.current = 'idle'
        }
        toast.error(extractIpcErrorMessage(error, String(error)))
        return false
      }
    },
    [completeGitRepoAdd]
  )

  const finish = useCallback(
    async (entry: HeldSetup): Promise<boolean> => {
      // Why: a repeat click from the step that just advanced must not complete the entry it never showed.
      if (pendingRef.current !== entry || completionRef.current !== 'idle') {
        return false
      }
      const remaining = queueRef.current.slice(1)
      if (remaining.length > 0) {
        queueRef.current = remaining
        pendingRef.current = remaining[0]
        setPending(remaining[0])
        return true
      }
      return completeHeld(entry)
    },
    [completeHeld]
  )

  const reset = useCallback(() => {
    epochRef.current += 1
    queueRef.current = []
    pendingRef.current = null
    detectingRef.current = false
    busyRef.current = false
    completionRef.current = 'idle'
    setPending(null)
  }, [])

  const requestDismiss = useCallback((): boolean => {
    const current = pendingRef.current
    if (current === null) {
      return false
    }
    // Why: dismissing skips every remaining optional setup and completes the add once.
    if (!busyRef.current) {
      void completeHeld(current)
    }
    return true
  }, [completeHeld])

  const onBusyChange = useCallback((busy: boolean) => {
    busyRef.current = busy
  }, [])

  return {
    onGitRepoReady,
    onGitRepoBatchReady,
    step: pending
      ? {
          repo: pending.repo,
          target: pending.target,
          onContinue: () => finish(pending),
          onBusyChange
        }
      : null,
    requestDismiss,
    reset
  }
}
