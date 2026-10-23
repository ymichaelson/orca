import { z } from 'zod'
import {
  isAgentSessionProtectedAnalysis,
  type AgentSessionProtectedAnalysis
} from './agent-session-protected-analysis'
import type { AGENT_SESSION_RECORD_SCHEMA_VERSION } from './agent-session-record'

export const PROTECTED_CLAUDE_PROFILE = 'claude-native-data-only-2.1.302-v1' as const
export const PROTECTED_CLAUDE_NATIVE_HASHES = {
  'darwin-arm64': '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37',
  'linux-x64': '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5',
  'win32-x64': '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae'
} as const

export function hasProtectedClaudeControlCharacter(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) <= 0x1f)
}

export function isProtectedClaudeAbsolutePath(value: string): boolean {
  return (
    value.length <= 32768 &&
    !hasProtectedClaudeControlCharacter(value) &&
    /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value) &&
    !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(value) &&
    !/[\\/]$/.test(value)
  )
}

export function canonicalProtectedClaudeEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.trim() !== value
    ) {
      throw new Error('protected_claude_endpoint_invalid')
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error('protected_claude_auth_unavailable')
  }
}

const path = z.string().refine(isProtectedClaudeAbsolutePath)
const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !hasProtectedClaudeControlCharacter(value))
const login = {
  email: identity.refine((value) => value.toLowerCase() === value),
  organizationUuid: identity.nullable()
}
export const protectedClaudeAuthReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('managed-oauth'), accountId: identity, configDir: path, ...login })
    .strict(),
  z
    .object({
      kind: z.literal('system-default-oauth'),
      userHome: path,
      configDir: path,
      stateFile: path,
      ...login
    })
    .strict(),
  z
    .object({
      kind: z.literal('saved-agent-env'),
      settingsKey: z.literal('claude'),
      credentialKey: z.enum(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
      baseUrl: z
        .string()
        .max(4096)
        .refine((value) => {
          try {
            return canonicalProtectedClaudeEndpoint(value) === value
          } catch {
            return false
          }
        })
    })
    .strict()
])
export type ProtectedClaudeAuthReference = z.infer<typeof protectedClaudeAuthReferenceSchema>
export const protectedClaudeLaunchSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal(PROTECTED_CLAUDE_PROFILE),
    executable: z
      .object({
        path,
        platform: z.enum(['darwin-arm64', 'linux-x64', 'win32-x64']),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .refine((value) => PROTECTED_CLAUDE_NATIVE_HASHES[value.platform] === value.sha256),
    privateRoot: path,
    auth: protectedClaudeAuthReferenceSchema
  })
  .strict()
export type ProtectedClaudeLaunchV1 = z.infer<typeof protectedClaudeLaunchSchema>

export function isProtectedClaudeModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

export function protectedClaudePrivatePath(root: string, name: 'home' | 'config' | 'work'): string {
  return `${root}${/^[A-Za-z]:\\/.test(root) ? '\\' : '/'}${name}`
}

export function isProtectedClaudeRecordBinding(value: {
  protectedClaudeLaunch?: unknown
  protectedAnalysis?: unknown
  provider?: unknown
  schemaVersion?: unknown
  accountHome?: unknown
  options?: unknown
  permissionMode?: unknown
  launchArgs?: unknown
}): boolean {
  if (value.protectedClaudeLaunch === undefined) {
    return true
  }
  const launch = protectedClaudeLaunchSchema.safeParse(value.protectedClaudeLaunch)
  const home = z
    .object({ variable: z.literal('CLAUDE_CONFIG_DIR'), path: z.string() })
    .strict()
    .safeParse(value.accountHome)
  const options = z.object({ model: z.string() }).strict().safeParse(value.options)
  return (
    launch.success &&
    home.success &&
    options.success &&
    isProtectedClaudeModel(options.data.model) &&
    value.schemaVersion === 3 &&
    value.provider === 'claude' &&
    isAgentSessionProtectedAnalysis(value.protectedAnalysis) &&
    home.data.path === protectedClaudePrivatePath(launch.data.privateRoot, 'config') &&
    (value.permissionMode === undefined || value.permissionMode === 'default') &&
    (value.launchArgs === undefined ||
      (Array.isArray(value.launchArgs) && value.launchArgs.length === 0))
  )
}

export function protectedClaudeLaunchEqual(
  left: ProtectedClaudeLaunchV1 | undefined,
  right: ProtectedClaudeLaunchV1 | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    JSON.stringify(protectedClaudeLaunchSchema.parse(left)) ===
    JSON.stringify(protectedClaudeLaunchSchema.parse(right))
  )
}

/** Whether the record's protection fields agree with its schema version. */
export function isProtectedRecordShape(
  record: Parameters<typeof isProtectedClaudeRecordBinding>[0],
  ordinarySchemaVersion: number
): boolean {
  return (
    isProtectedClaudeRecordBinding(record) &&
    (record.schemaVersion === 3
      ? isAgentSessionProtectedAnalysis(record.protectedAnalysis)
      : record.schemaVersion === ordinarySchemaVersion && record.protectedAnalysis === undefined)
  )
}

export type AgentSessionProtectionFields = {
  protectedAnalysis?: AgentSessionProtectedAnalysis
  protectedClaudeLaunch?: ProtectedClaudeLaunchV1
}

export type AgentSessionRecordSchemaVersion = typeof AGENT_SESSION_RECORD_SCHEMA_VERSION | 3
