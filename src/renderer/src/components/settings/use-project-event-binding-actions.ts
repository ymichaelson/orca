import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { retryProjectEvent, rotateProjectEventSecret } from '@/runtime/project-event-client'
import type { ForgeInboxProjectEventBindingActionOutcome } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { bindingActionFailureCopy } from './project-event-status-copy'

export type ProjectEventBindingAction = 'retry' | 'rotate'

type ProjectEventBindingActionsInput = {
  ownerHostId: string | null
  repoId: string
  target: RuntimeClientTarget
  /** True while the policy save owns the shared guard, so a second write cannot overlap it. */
  disabled: boolean
  /** Called after every attempt so the binding and activity reflect what the host now has. */
  onCompleted: () => Promise<void>
}

/** Retry and rotate both re-run host-side work; neither may overlap the policy save. */
export function useProjectEventBindingActions(input: ProjectEventBindingActionsInput) {
  const { ownerHostId, repoId, target, disabled, onCompleted } = input
  const [busy, setBusy] = useState<ProjectEventBindingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offersUnprotected, setOffersUnprotected] = useState(false)
  const scope = useRef({ active: true, busy: false }).current

  useEffect(() => {
    scope.active = true
    return () => {
      scope.active = false
    }
  }, [scope])

  const run = async (
    kind: ProjectEventBindingAction,
    invoke: () => Promise<ForgeInboxProjectEventBindingActionOutcome>
  ): Promise<boolean> => {
    if (!scope.active || scope.busy || disabled || ownerHostId === null) {
      return false
    }
    scope.busy = true
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke()
      if (!scope.active) {
        return false
      }
      if (result.ok) {
        setOffersUnprotected(false)
        if (kind === 'rotate') {
          setNotice(translate('projectEventAgent.rotate.done', 'The new secret is in use.'))
        }
      } else {
        setOffersUnprotected(kind === 'rotate' && result.code === 'unprotected-storage')
        setError(bindingActionFailureCopy(kind, result.code ?? ''))
      }
      await onCompleted().catch(() => {})
      return result.ok
    } catch {
      if (scope.active) {
        setError(
          translate(
            'projectEventAgent.action.failed',
            'The host did not answer. Check the connection and try again.'
          )
        )
      }
      return false
    } finally {
      scope.busy = false
      if (scope.active) {
        setBusy(null)
      }
    }
  }

  const retry = (): Promise<boolean> => {
    if (ownerHostId === null) {
      return Promise.resolve(false)
    }
    return run('retry', () => retryProjectEvent(ownerHostId, repoId, target))
  }

  /** Unprotected storage is only ever sent after the user's explicit second confirmation. */
  const rotate = (allowUnprotectedStorage = false): Promise<boolean> => {
    if (ownerHostId === null) {
      return Promise.resolve(false)
    }
    return run('rotate', () =>
      rotateProjectEventSecret(
        ownerHostId,
        repoId,
        allowUnprotectedStorage ? { allowUnprotectedStorage: true } : {},
        target
      )
    )
  }

  return { busy, error, notice, offersUnprotected, retry, rotate }
}
