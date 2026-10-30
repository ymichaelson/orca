import type { GlobalSettings } from '../../../shared/global-settings-types'
import { parseProjectEventReceiverSettings } from '../../../shared/project-event-receiver-settings'
import {
  parseProjectEventDecisionSettings,
  projectEventDecisionKeySchema
} from '../../../shared/project-event-decision-settings'
import {
  PROTECTED_SECRET_SLOT,
  protectedSecretStorageAvailable,
  type ProtectedSecretPersistence
} from '../../protected-secret-persistence'

export function sanitizeProjectEventSettingsUpdate(
  updates: Partial<GlobalSettings>,
  sanitizedUpdates: Partial<GlobalSettings>
): void {
  if ('projectEventReceiver' in updates) {
    sanitizedUpdates.projectEventReceiver = parseProjectEventReceiverSettings(
      updates.projectEventReceiver
    )
  }
  if ('projectEventDecision' in updates) {
    sanitizedUpdates.projectEventDecision = parseProjectEventDecisionSettings(
      updates.projectEventDecision
    )
  }
  for (const field of ['projectEventDecisionKey', 'projectEventDecisionLayaKey'] as const) {
    if (field in updates && !projectEventDecisionKeySchema.safeParse(updates[field]).success) {
      throw new Error('Invalid project event decision key')
    }
    if (updates[field] && !protectedSecretStorageAvailable()) {
      throw new Error('Protected storage is unavailable for the project event decision key')
    }
  }
}

export function clearRetainedProjectEventKeys(
  updates: Partial<GlobalSettings>,
  removeRetainedBlob: ProtectedSecretPersistence['removeRetainedBlob']
): void {
  for (const field of ['projectEventDecisionKey', 'projectEventDecisionLayaKey'] as const) {
    if (field in updates && !updates[field]) {
      removeRetainedBlob(PROTECTED_SECRET_SLOT[field])
    }
  }
}
