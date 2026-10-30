import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProjectEventReceiverSettings } from '../../shared/project-event-receiver-settings'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

export type ProjectEventReceiverSettingsSource = {
  read: () => ProjectEventReceiverSettings | undefined
  subscribe: (listener: () => void) => () => void
}

export function projectEventReceiverSettingsForStore(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'>
): ProjectEventReceiverSettingsSource {
  return {
    read: () => store.getSettings().projectEventReceiver,
    subscribe: (listener) =>
      store.onSettingsChanged?.((updates: Partial<GlobalSettings>) => {
        if (Object.hasOwn(updates, 'projectEventReceiver')) {
          listener()
        }
      }) ?? (() => undefined)
  }
}
