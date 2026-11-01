import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeProjectEventDefaultRules } from '../../../../shared/project-event-default-rules-settings'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '../../store'

/**
 * The rules template a project's first policy save starts from: the owner host's global setting
 * for a remote host, the local store's mirror for the local one. An unreadable source falls back
 * to the shipped template inside the normalizer, so a failed read never blocks the settings page.
 */
export async function readProjectEventDefaultRules(target: RuntimeClientTarget): Promise<string> {
  if (target.kind !== 'environment') {
    return normalizeProjectEventDefaultRules(
      useAppStore.getState().settings?.projectEventDefaultRules
    )
  }
  try {
    const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
      target,
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    )
    return normalizeProjectEventDefaultRules(result.settings.projectEventDefaultRules)
  } catch {
    return normalizeProjectEventDefaultRules(undefined)
  }
}
