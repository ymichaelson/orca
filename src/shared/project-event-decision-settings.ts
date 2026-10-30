import { z } from 'zod'
import {
  decisionModelTextSchema,
  type ProjectEventDecisionProvider
} from './project-event-decision'

export type ProjectEventDecisionSettings = {
  provider: ProjectEventDecisionProvider
  model: string
  /** Empty uses the provider default. Laya requires an explicit endpoint. */
  baseUrl: string
}

export const PROJECT_EVENT_DECISION_SETTINGS_CAPABILITY =
  'project-events.decision-settings.v1' as const

export type ProjectEventDecisionKeyFields = {
  projectEventDecisionKey?: string
  projectEventDecisionLayaKey?: string
}

export type ProjectEventDecisionSettingsView = ProjectEventDecisionSettings & {
  /** Per provider, so switching never reads another provider's key state as its own. */
  apiKeysSaved: Record<ProjectEventDecisionProvider, boolean>
  /**
   * A key whose ciphertext survived but whose plaintext this process could not read. It is not
   * usable, yet the client must be able to offer Clear so the stored secret can be removed.
   */
  apiKeysSealed?: Record<ProjectEventDecisionProvider, boolean>
}

export type ProjectEventDecisionManagementView = {
  ownerHostId: string
  settings: ProjectEventDecisionSettingsView
  protection: 'available' | 'unavailable'
}

export const DEFAULT_PROJECT_EVENT_DECISION_SETTINGS: ProjectEventDecisionSettings = {
  provider: 'jev',
  model: '',
  baseUrl: ''
}

const MODEL = decisionModelTextSchema
const API_KEY = z
  .string()
  .max(8192)
  .refine((value) => value === '' || /^[\x21-\x7e]+$/.test(value))

export const projectEventDecisionSettingsSchema = z.strictObject(
  {
    provider: z.enum(['jev', 'laya']),
    model: MODEL,
    baseUrl: z.string().refine((value) => value === '' || decisionBaseUrl(value) !== null)
  },
  { error: 'Invalid project event decision settings' }
)

/** A key is empty or visible ASCII. Anything else is refused rather than stored. */
export const projectEventDecisionKeySchema = API_KEY

export function parseProjectEventDecisionSettings(value: unknown): ProjectEventDecisionSettings {
  const parsed = projectEventDecisionSettingsSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Invalid project event decision settings')
  }
  return {
    ...parsed.data,
    baseUrl: decisionBaseUrl(parsed.data.baseUrl) ?? ''
  }
}

/** Keeps the API path intact; URL decorations are not endpoint configuration. */
export function decisionBaseUrl(value: string): string | null {
  if (value === '') {
    return ''
  }
  if (/[\s\\?#]/.test(value)) {
    return null
  }
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Jev's endpoint is fixed: a saved Laya address must never redirect Jev traffic — or its key —
 * to another host, so only Laya contributes a base URL.
 */
export function decisionClientBaseUrl(settings: ProjectEventDecisionSettings): string {
  return settings.provider === 'laya' ? settings.baseUrl : ''
}

/** Each provider keeps its own key, so switching never sends one provider's key to the other. */
export function decisionApiKeyForProvider(
  provider: ProjectEventDecisionProvider,
  keys: ProjectEventDecisionKeyFields
): string {
  return (
    (provider === 'laya' ? keys.projectEventDecisionLayaKey : keys.projectEventDecisionKey) ?? ''
  )
}

/** Invalid stored fields become empty without preventing the host from starting. */
export function normalizeProjectEventDecisionSettings(
  value: unknown
): ProjectEventDecisionSettings {
  const input = isRecord(value) ? value : {}
  const provider = input.provider === 'laya' ? 'laya' : 'jev'
  const model =
    typeof input.model === 'string' && MODEL.safeParse(input.model).success ? input.model : ''
  const baseUrl = typeof input.baseUrl === 'string' ? (decisionBaseUrl(input.baseUrl) ?? '') : ''
  return { provider, model, baseUrl }
}

/** What a client may read. The key itself stays on the host that makes the request. */
export function projectEventDecisionSettingsView(
  settings: ProjectEventDecisionSettings,
  keys: ProjectEventDecisionKeyFields,
  sealed: Partial<Record<ProjectEventDecisionProvider, boolean>> = {}
): ProjectEventDecisionSettingsView {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKeysSaved: {
      jev: (keys.projectEventDecisionKey ?? '') !== '',
      laya: (keys.projectEventDecisionLayaKey ?? '') !== ''
    },
    apiKeysSealed: { jev: sealed.jev === true, laya: sealed.laya === true }
  }
}
