import { readForgeInboxStatus } from '@/runtime/forge-inbox-client'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId
} from '../../../../shared/execution-host'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Hosts withhold a capability while the service is detached, so the owner is checked before blame. */
export type OwnerScopeLoadState = 'loading' | 'ready' | 'unsupported' | 'unattached'

/** `forgeInbox.getStatus` omits the owner until the service is attached on that host. */
export function statusOwnerHostId(status: ForgeInboxStatus | null | undefined): string | null {
  if (status === null || typeof status !== 'object') {
    return null
  }
  return 'ownerHostId' in status && typeof status.ownerHostId === 'string'
    ? status.ownerHostId
    : null
}

/** A host withholds a capability while its service is detached, so check before blaming the host. */
export async function loadStateWithoutCapability(
  target: RuntimeClientTarget
): Promise<OwnerScopeLoadState> {
  try {
    return statusOwnerHostId(await readForgeInboxStatus(target)) === null
      ? 'unattached'
      : 'unsupported'
  } catch {
    return 'unsupported'
  }
}

/** A direct SSH row has no inbox route from this app; a local call would answer for another host. */
export function projectEventOwnerTarget(repo: Repo): RuntimeClientTarget | null {
  const host = parseRoutableExecutionHostId(getRepoExecutionHostId(repo))
  return host === null || host.kind === 'ssh' ? null : ipcOrRuntimeTargetForHostId(host.id)
}

export function agentDetectionTargetFor(target: RuntimeClientTarget): AgentDetectionTarget {
  return target.kind === 'environment'
    ? { kind: 'runtime', environmentId: target.environmentId }
    : { kind: 'local' }
}
