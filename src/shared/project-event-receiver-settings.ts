import { z } from 'zod'
import { canonicalReceiverBaseUrl, FORGE_INBOX_DEFAULT_PORT } from './forge-inbox-config'

export type ProjectEventReceiverSettings = {
  enabled: boolean
  bindAddress: string
  port: number
  externalBaseUrl: string
  acknowledgeExternalPlaintextHttp: boolean
}

export const DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS: ProjectEventReceiverSettings = {
  enabled: false,
  bindAddress: '127.0.0.1',
  port: FORGE_INBOX_DEFAULT_PORT,
  externalBaseUrl: '',
  acknowledgeExternalPlaintextHttp: false
}

export function receiverRequiresPlaintextAcknowledgement(
  settings: ProjectEventReceiverSettings
): boolean {
  if (!settings.enabled || settings.acknowledgeExternalPlaintextHttp) {
    return false
  }
  if (!['127.0.0.1', '::1'].includes(settings.bindAddress.toLowerCase())) {
    return true
  }
  const base = receiverBaseUrl(settings)
  return (
    base !== null &&
    base.startsWith('http:') &&
    !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(base).hostname)
  )
}

export const projectEventReceiverSettingsValueSchema = z.strictObject({
  enabled: z.boolean(),
  bindAddress: z.union([z.ipv4(), z.ipv6()]),
  port: z.number().int().min(1).max(65535),
  externalBaseUrl: z
    .string()
    .refine((value) => value === '' || canonicalReceiverBaseUrl(value) !== null),
  acknowledgeExternalPlaintextHttp: z.boolean()
})

export const projectEventReceiverSettingsSchema = projectEventReceiverSettingsValueSchema.refine(
  (settings) => !receiverRequiresPlaintextAcknowledgement(settings)
)

export function parseProjectEventReceiverSettings(value: unknown): ProjectEventReceiverSettings {
  const parsed = projectEventReceiverSettingsSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Invalid project event receiver settings')
  }
  return {
    ...parsed.data,
    externalBaseUrl: canonicalReceiverBaseUrl(parsed.data.externalBaseUrl) ?? ''
  }
}

/** The externally reachable base a remote GitLab can call back; null when unset or invalid. */
export function receiverBaseUrl(settings: ProjectEventReceiverSettings): string | null {
  return canonicalReceiverBaseUrl(settings.externalBaseUrl)
}

function asEnabled(value: unknown): boolean {
  return value === true
}

function asBindAddress(value: unknown): string {
  if (typeof value === 'string') {
    if (z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success) {
      return value
    }
  }
  return DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS.bindAddress
}

function asPort(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value
  }
  return DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS.port
}

function asExternalBaseUrl(value: unknown): string {
  if (typeof value === 'string') {
    return canonicalReceiverBaseUrl(value) ?? ''
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clamps hand-edited or older-build input to a safe value; never throws, never yields a bad base URL. */
export function normalizeProjectEventReceiverSettings(
  value: unknown
): ProjectEventReceiverSettings {
  const input = isRecord(value) ? value : {}
  return {
    enabled: asEnabled(input.enabled),
    bindAddress: asBindAddress(input.bindAddress),
    port: asPort(input.port),
    externalBaseUrl: asExternalBaseUrl(input.externalBaseUrl),
    acknowledgeExternalPlaintextHttp: asEnabled(input.acknowledgeExternalPlaintextHttp)
  }
}
