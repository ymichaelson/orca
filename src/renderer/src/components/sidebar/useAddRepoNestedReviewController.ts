import type { Dispatch, SetStateAction } from 'react'
import type { ProjectGroupImportResult } from '../../../../shared/project-group-types'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import { useAddRepoNestedImportFlow } from './useAddRepoNestedImportFlow'
import { useAddRepoNestedReviewState } from './useAddRepoNestedReviewState'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { GitRepoBatchHandoff } from './use-add-repo-project-event-setup'

export function useAddRepoNestedReviewController({
  activeRuntimeEnvironmentId,
  cancelNestedRepoScan,
  closeModal,
  fetchWorktrees,
  importNestedRepos,
  onGitRepoBatchReady,
  setIsAdding,
  setStep,
  reviewRuntimeEnvironmentId
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  reviewRuntimeEnvironmentId: string | null | undefined
  cancelNestedRepoScan: (
    scanId: string,
    options: { runtimeEnvironmentId: string | null }
  ) => Promise<unknown>
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    runtimeEnvironmentId: string | null
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  onGitRepoBatchReady: (handoff: GitRepoBatchHandoff) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setStep: Dispatch<SetStateAction<AddRepoDialogStep>>
}): ReturnType<typeof useAddRepoNestedReviewState> &
  Pick<
    ReturnType<typeof useAddRepoNestedImportFlow>,
    | 'handleImportNestedRepos'
    | 'handleOpenNestedRootFolder'
    | 'resetNestedImportFlow'
    | 'trackNestedBackAction'
  > {
  const review = useAddRepoNestedReviewState({
    activeRuntimeEnvironmentId: reviewRuntimeEnvironmentId,
    cancelNestedRepoScan,
    setStep
  })
  const imports = useAddRepoNestedImportFlow({
    activeRuntimeEnvironmentId,
    closeModal,
    fetchWorktrees,
    importNestedRepos,
    onGitRepoBatchReady,
    setIsAdding,
    nestedAttemptId: review.nestedAttemptId,
    nestedScan: review.nestedScan,
    nestedSelectedPaths: review.nestedSelectedPaths,
    nestedRuntimeKind: review.nestedRuntimeKind,
    nestedConnectionId: review.nestedConnectionId,
    nestedGroupName: review.nestedGroupName,
    nestedImportScanId: review.nestedImportScanId,
    nestedRuntimeEnvironmentId: review.nestedRuntimeEnvironmentId,
    getNestedRepoRuntimeKind: review.getNestedRepoRuntimeKind
  })
  return { ...review, ...imports }
}
