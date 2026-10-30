import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'

export function useForgeInboxArchiveSupport(
  target: RuntimeClientTarget,
  reloadToken = 0
): boolean | null {
  const observation = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const environmentId = runtimeTargetEnvironmentId(target)
  // Why: an answer belongs to the host that gave it, and a previous owner's is never lent.
  const [remote, setRemote] = useState<{ environmentId: string; supported: boolean } | null>(null)

  useEffect(() => {
    if (environmentId === null) {
      void ensureLocalRuntimeCapabilities()
      return
    }
    let active = true
    runtimeEnvironmentSupportsCapability(environmentId, FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY)
      .then((supported) => {
        if (active) {
          setRemote({ environmentId, supported })
        }
      })
      .catch(() => {
        // Why: a failed probe is not evidence about the host, so it stays unknown.
        if (active) {
          setRemote(null)
        }
      })
    return () => {
      active = false
    }
  }, [environmentId, reloadToken])

  if (environmentId === null) {
    return observation.state === 'known'
      ? observation.capabilities.includes(FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY)
      : null
  }
  return remote !== null && remote.environmentId === environmentId ? remote.supported : null
}
