import { z } from 'zod'
import {
  projectEventDecisionKeySchema,
  projectEventDecisionSettingsSchema
} from '../project-event-decision-settings'

const ownerHostId = z.string().min(1).max(200)

const requestError = { error: 'Invalid project event decision request' } as const

export const ProjectEventDecisionOwnerParams = z.strictObject({ ownerHostId }, requestError)
export const ProjectEventDecisionSaveSettingsParams = z.strictObject(
  { ownerHostId, settings: projectEventDecisionSettingsSchema },
  requestError
)
const provider = z.enum(['jev', 'laya'])

// Why the provider travels with the key: each provider stores its own, so a save or clear can
// never overwrite the key another provider is still using.
export const ProjectEventDecisionSaveApiKeyParams = z.strictObject(
  {
    ownerHostId,
    provider,
    apiKey: projectEventDecisionKeySchema.refine((value) => value.length > 0)
  },
  requestError
)

export const ProjectEventDecisionClearApiKeyParams = z.strictObject(
  { ownerHostId, provider },
  requestError
)
