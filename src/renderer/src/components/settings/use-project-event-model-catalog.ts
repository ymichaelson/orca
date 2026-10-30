import { useEffect, useMemo, useState } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from '../native-chat/host-model-listing-waits'

export type ProjectEventModelChoice = { id: string; label: string }

export type ProjectEventModelCatalog =
  | { status: 'unlisted' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'ready'; models: ProjectEventModelChoice[]; workspaceSpecific: boolean }

const UNLISTED: ProjectEventModelCatalog = { status: 'unlisted' }
const LOADING: ProjectEventModelCatalog = { status: 'loading' }

function catalogFromHostAnswer(answer: AgentSessionModelCatalogResult): ProjectEventModelCatalog {
  return answer.origin === 'unknown' || answer.models.length === 0
    ? { status: 'empty' }
    : {
        status: 'ready',
        models: answer.models.map(({ id, label }) => ({ id, label })),
        workspaceSpecific: answer.modelsDifferByWorkspace === true
      }
}

/** The owner host's saved model list for the agent; a failed or missing list degrades to manual entry. */
export function useProjectEventModelCatalog(
  target: RuntimeClientTarget,
  agentId: string | null
): ProjectEventModelCatalog {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  // Why: callers rebuild `target` every render, so the effect keys on the host, not the object.
  const hostTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const key =
    agentId === null ? null : `${structuredAgentSessionHostKey(hostTarget)}\u0000${agentId}`
  const [answer, setAnswer] = useState<{
    key: string
    catalog: ProjectEventModelCatalog
  } | null>(null)

  useEffect(() => {
    if (agentId === null || key === null) {
      return
    }
    let stale = false
    const settle = (catalog: ProjectEventModelCatalog): void => {
      if (!stale) {
        setAnswer({ key, catalog })
      }
    }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        hostTarget,
        'agentSession.modelCatalog',
        waitForListing ? { agent: agentId, waitForListing } : { agent: agentId }
      )
    const land = (result: AgentSessionModelCatalogResult): void =>
      settle(catalogFromHostAnswer(result))
    const waitKey = `${key}\u0000project-event`
    let leave: (() => void) | null = null
    const waitForListing = (): void => {
      leave = joinHostModelListingWait(
        waitKey,
        () => read(true),
        (result) => (result ? land(result) : settle({ status: 'error' }))
      )
    }
    if (isHostModelListingWaitInFlight(waitKey)) {
      waitForListing()
    } else {
      read(false)
        .then((result) => {
          // Only a host that reports its listing running knows the wait param; an older one refuses it.
          if (result.listingInProgress === true && result.origin === 'unknown') {
            if (!stale) {
              waitForListing()
            }
          } else {
            land(result)
          }
        })
        .catch(() => settle({ status: 'error' }))
    }
    return () => {
      stale = true
      leave?.()
    }
  }, [hostTarget, key, agentId])

  if (agentId === null || key === null) {
    return UNLISTED
  }
  if (answer?.key === key) {
    return answer.catalog
  }
  const known = readHostModelCatalogSnapshot(hostTarget, agentId, {
    newLaunch: false,
    seedsModel: false
  })
  return known === undefined ? LOADING : catalogFromHostAnswer(known)
}
