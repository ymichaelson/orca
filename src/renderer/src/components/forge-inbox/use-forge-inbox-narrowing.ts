import { useEffect, useRef, useState } from 'react'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import type { ForgeItemKind } from '../../../../shared/forge-inbox-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { listForgeInboxProjects } from '@/runtime/forge-inbox-client'

export type ForgeInboxNarrowing = {
  /** The options the host names; an older host names none and offers no project control. */
  projects: string[]
  projectFilter: string | null
  kindFilter: ForgeItemKind | null
  handlingFilter: ForgeItemHandlingState | null
  setProjectFilter: (projectId: string | null) => void
  setKindFilter: (kind: ForgeItemKind | null) => void
  setHandlingFilter: (handling: ForgeItemHandlingState | null) => void
}

/** A narrowed view is this window's own: it is not a stored preference and never outlives it. */
export function useForgeInboxNarrowing(
  ownerHostId: string | null,
  requestTarget: RuntimeClientTarget,
  reloadToken: number
): ForgeInboxNarrowing {
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<ForgeItemKind | null>(null)
  const [handlingFilter, setHandlingFilter] = useState<ForgeItemHandlingState | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  // Why: a slower answer for a previous owner must not overwrite the current host's projects.
  const projectsRequest = useRef(0)

  useEffect(() => {
    setProjects([])
    if (ownerHostId === null) {
      return
    }
    const request = ++projectsRequest.current
    listForgeInboxProjects(ownerHostId, requestTarget)
      .then((view) => {
        if (request === projectsRequest.current) {
          setProjects(view.projects)
        }
      })
      // Why: a host older than this method offers no project filter, and the list stays usable.
      .catch(() => {
        if (request === projectsRequest.current) {
          setProjects([])
        }
      })
  }, [ownerHostId, requestTarget, reloadToken])

  // Why: a project the host no longer holds must not leave the list silently empty.
  useEffect(() => {
    if (projectFilter !== null && !projects.includes(projectFilter)) {
      setProjectFilter(null)
    }
  }, [projectFilter, projects])

  return {
    projects,
    projectFilter,
    kindFilter,
    handlingFilter,
    setProjectFilter,
    setKindFilter,
    setHandlingFilter
  }
}
