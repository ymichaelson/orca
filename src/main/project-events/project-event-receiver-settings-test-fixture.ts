import {
  DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
  type ProjectEventReceiverSettings
} from '../../shared/project-event-receiver-settings'

export function createReceiverSettingsFixture() {
  let settings = { ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS }
  const listeners = new Set<() => void>()
  return {
    read: () => settings,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(updates: Partial<ProjectEventReceiverSettings>) {
      settings = { ...settings, ...updates }
      for (const listener of listeners) {
        listener()
      }
    },
    subscriptions: () => listeners.size
  }
}
