import type { GlobalSettings } from '../../../shared/global-settings-types'
import { parseProjectEventReceiverSettings } from '../../../shared/project-event-receiver-settings'
import {
  parseProjectEventDecisionSettings,
  projectEventDecisionKeySchema
} from '../../../shared/project-event-decision-settings'
import { normalizeProjectEventDefaultRules } from '../../../shared/project-event-default-rules-settings'
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
  if ('projectEventDefaultRules' in updates) {
    // Why normalize, not reject: the template is a starting point, so an oversized edit is
    // clamped back to the shipped default instead of blocking the whole settings write.
    sanitizedUpdates.projectEventDefaultRules = normalizeProjectEventDefaultRules(
      updates.projectEventDefaultRules
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
