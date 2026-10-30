import { useCallback } from 'react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

/** Back and close both reset the flow, except that closing over the event agent step continues the add. */
export function useAddRepoDialogDismissal({
  step,
  isAdding,
  closeModal,
  resetState,
  trackNestedBackAction,
  dismissProjectEventStep
}: {
  step: AddRepoDialogStep
  isAdding: boolean
  closeModal: () => void
  resetState: () => void
  trackNestedBackAction: () => void
  dismissProjectEventStep: () => boolean
}): { handleBack: () => void; handleOpenChange: (open: boolean) => void } {
  const handleBack = useCallback(() => {
    if (step === 'nested') {
      trackNestedBackAction()
    }
    resetState()
  }, [resetState, step, trackNestedBackAction])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      // Why: the repo is already added, so closing here only skips the event agent.
      if (dismissProjectEventStep()) {
        return
      }
      if (step === 'nested' && !isAdding) {
        trackNestedBackAction()
      }
      closeModal()
      resetState()
    },
    [closeModal, dismissProjectEventStep, isAdding, resetState, step, trackNestedBackAction]
  )

  return { handleBack, handleOpenChange }
}
