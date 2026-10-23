import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  hasProtectedClaudeControlCharacter,
  canonicalProtectedClaudeEndpoint,
  protectedClaudeAuthReferenceSchema,
  type ProtectedClaudeAuthReference
} from '../../shared/agent-session-protected-claude-launch'
import { claudeStateLogin, type ClaudeFolderLogin } from '../claude-accounts/claude-account-folder'
import { describeClaudeProfile } from '../claude-accounts/claude-profile-paths'
import { readClaudeOAuthCredentials } from '../rate-limits/claude-oauth-credentials'

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed-oauth'), accountId: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal('system-default-oauth'),
      userHome: z.string(),
      configDir: z.string(),
      stateFile: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('saved-agent-env'),
      credentialKey: z.enum(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']).optional()
    })
    .strict()
])
export type ProtectedClaudeAuthSource = z.infer<typeof sourceSchema>
export type ProtectedClaudeAuthDeps = {
  stateDirectory: string
  getSettings: () => {
    claudeManagedAccounts?: readonly ClaudeManagedAccount[]
    agentDefaultEnv?: Record<string, Record<string, string> | undefined>
  }
  readLogin?: (
    stateFile: string,
    maxAgeMs?: number
  ) => ClaudeFolderLogin | null | Promise<ClaudeFolderLogin | null>
  readCredentials?: typeof readClaudeOAuthCredentials
}

function unavailable(): never {
  throw new Error('protected_claude_auth_unavailable')
}
function normalizedEmail(value: string): string {
  return value.trim().toLowerCase()
}
async function readLogin(file: string, deps: ProtectedClaudeAuthDeps): Promise<ClaudeFolderLogin> {
  if (deps.readLogin) {
    const login = await deps.readLogin(file, 0)
    return login ?? unavailable()
  }
  const state = z
    .record(z.string(), z.unknown())
    .safeParse(JSON.parse(await readFile(file, 'utf8')))
  return (state.success ? claudeStateLogin(state.data) : null) ?? unavailable()
}
function managedAccount(id: string, deps: ProtectedClaudeAuthDeps): ClaudeManagedAccount {
  const accounts =
    deps.getSettings().claudeManagedAccounts?.filter((account) => account.id === id) ?? []
  const account = accounts.length === 1 ? accounts[0] : undefined
  if (
    !account ||
    account.managedAuthRuntime === 'wsl' ||
    account.wslDistro ||
    account.authMethod !== 'subscription-oauth'
  ) {
    return unavailable()
  }
  const expected = describeClaudeProfile(deps.stateDirectory, id, {
    executionHostId: 'local',
    runtime: 'host'
  }).home
  if (expected !== account.managedAuthPath) {
    return unavailable()
  }
  return account
}
function savedMap(deps: ProtectedClaudeAuthDeps): Record<string, string> {
  return deps.getSettings().agentDefaultEnv?.claude ?? {}
}
function savedEndpoint(env: Record<string, string>): string {
  return canonicalProtectedClaudeEndpoint(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')
}
function requireSecret(value: string | null | undefined): string {
  if (
    !value ||
    value.trim() !== value ||
    hasProtectedClaudeControlCharacter(value) ||
    value.length > 65536
  ) {
    return unavailable()
  }
  return value
}
function requireDefaultHomeLayout(source: {
  userHome: string
  configDir: string
  stateFile: string
}): void {
  if (
    source.configDir !== join(source.userHome, '.claude') ||
    source.stateFile !== join(source.userHome, '.claude.json')
  ) {
    unavailable()
  }
}
function requireReference(value: unknown): ProtectedClaudeAuthReference {
  const parsed = protectedClaudeAuthReferenceSchema.safeParse(value)
  return parsed.success ? parsed.data : unavailable()
}

export async function bindProtectedClaudeAuth<S extends ProtectedClaudeAuthSource>(
  source: S,
  deps: ProtectedClaudeAuthDeps
): Promise<Extract<ProtectedClaudeAuthReference, { kind: S['kind'] }>>
export async function bindProtectedClaudeAuth(
  source: ProtectedClaudeAuthSource,
  deps: ProtectedClaudeAuthDeps
): Promise<ProtectedClaudeAuthReference> {
  try {
    const selected = sourceSchema.safeParse(source)
    if (!selected.success) {
      return unavailable()
    }
    const input = selected.data
    let reference: ProtectedClaudeAuthReference
    if (input.kind === 'saved-agent-env') {
      const env = savedMap(deps)
      const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const
      const present = keys.filter((key) => Boolean(env[key]))
      const credentialKey = input.credentialKey ?? (present.length === 1 ? present[0] : undefined)
      if (!credentialKey) {
        return unavailable()
      }
      requireSecret(env[credentialKey])
      reference = {
        kind: input.kind,
        settingsKey: 'claude',
        credentialKey,
        baseUrl: savedEndpoint(env)
      }
    } else if (input.kind === 'managed-oauth') {
      const account = managedAccount(input.accountId, deps)
      const login = await readLogin(join(account.managedAuthPath, '.claude.json'), deps)
      if (
        normalizedEmail(login.email) !== normalizedEmail(account.email) ||
        login.organizationUuid !== (account.organizationUuid ?? null)
      ) {
        return unavailable()
      }
      reference = {
        kind: input.kind,
        accountId: account.id,
        configDir: account.managedAuthPath,
        email: normalizedEmail(login.email),
        organizationUuid: login.organizationUuid
      }
    } else {
      requireDefaultHomeLayout(input)
      const login = await readLogin(input.stateFile, deps)
      reference = {
        ...input,
        email: normalizedEmail(login.email),
        organizationUuid: login.organizationUuid
      }
    }
    reference = requireReference(reference)
    await readProtectedClaudeAuth(reference, deps)
    return reference
  } catch {
    return unavailable()
  }
}

export async function readProtectedClaudeAuth(
  reference: ProtectedClaudeAuthReference,
  deps: ProtectedClaudeAuthDeps
): Promise<Record<string, string>> {
  try {
    const ref = requireReference(reference)
    if (ref.kind === 'saved-agent-env') {
      const env = savedMap(deps)
      if (savedEndpoint(env) !== ref.baseUrl) {
        return unavailable()
      }
      return {
        [ref.credentialKey]: requireSecret(env[ref.credentialKey]),
        ANTHROPIC_BASE_URL: ref.baseUrl
      }
    }
    if (ref.kind === 'managed-oauth') {
      const account = managedAccount(ref.accountId, deps)
      if (
        account.managedAuthPath !== ref.configDir ||
        normalizedEmail(account.email) !== ref.email ||
        (account.organizationUuid ?? null) !== ref.organizationUuid
      ) {
        return unavailable()
      }
    }
    if (ref.kind === 'system-default-oauth') {
      requireDefaultHomeLayout(ref)
    }
    const file = ref.kind === 'managed-oauth' ? join(ref.configDir, '.claude.json') : ref.stateFile
    const login = await readLogin(file, deps)
    if (
      normalizedEmail(login.email) !== ref.email ||
      login.organizationUuid !== ref.organizationUuid
    ) {
      return unavailable()
    }
    const credentials = await (deps.readCredentials ?? readClaudeOAuthCredentials)({
      credentialsFileConfigDir: ref.configDir,
      keychainConfigDir: ref.configDir,
      unsuffixedKeychainFallback: ref.kind === 'system-default-oauth'
    })
    if (credentials.unavailable || credentials.keychainUnavailable) {
      return unavailable()
    }
    return { CLAUDE_CODE_OAUTH_TOKEN: requireSecret(credentials.token) }
  } catch {
    return unavailable()
  }
}
