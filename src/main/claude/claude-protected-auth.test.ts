import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeFolderLogin } from '../claude-accounts/claude-account-folder'
import type {
  ClaudeOAuthCredentialReadResult,
  readClaudeOAuthCredentials
} from '../rate-limits/claude-oauth-credentials'
import { bindProtectedClaudeAuth, readProtectedClaudeAuth } from './claude-protected-auth'

const MANAGED: ClaudeManagedAccount = {
  id: 'account-a',
  email: 'owner@example.test',
  managedAuthPath: '/fake/orca/claude-profiles/account-a/home',
  managedAuthRuntime: 'host',
  authMethod: 'subscription-oauth',
  organizationUuid: 'org-a',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}
const DEFAULT_SOURCE = {
  kind: 'system-default-oauth',
  userHome: '/fake/user',
  configDir: '/fake/user/.claude',
  stateFile: '/fake/user/.claude.json'
} as const

function rig() {
  const state: {
    accounts: ClaudeManagedAccount[]
    active: string | null
    savedEnv: Record<string, string>
    login: ClaudeFolderLogin | null
    credentials: ClaudeOAuthCredentialReadResult
  } = {
    accounts: [{ ...MANAGED }],
    active: MANAGED.id,
    savedEnv: {
      ANTHROPIC_API_KEY: 'fake-key-one',
      ANTHROPIC_BASE_URL: 'https://model.example.test/v1',
      GITLAB_TOKEN: 'fake-forge-canary'
    },
    login: { email: MANAGED.email, organizationUuid: 'org-a', organizationName: null },
    credentials: {
      token: 'fake-oauth-one',
      hasRefreshableCredentials: true,
      source: 'credentials-file'
    }
  }
  const readLogin = vi.fn(async (_stateFile: string, _maxAgeMs?: number) => state.login)
  const readCredentials = vi.fn(
    async (_options: Parameters<typeof readClaudeOAuthCredentials>[0]) => state.credentials
  )
  const deps = {
    stateDirectory: '/fake/orca',
    getSettings: () => ({
      claudeManagedAccounts: state.accounts,
      activeClaudeManagedAccountId: state.active,
      agentDefaultEnv: { claude: state.savedEnv }
    }),
    readLogin,
    readCredentials
  }
  return { state, deps, readLogin, readCredentials }
}

afterEach(() => vi.unstubAllEnvs())

describe('protected authentication binds one explicit host source without persisting secrets', () => {
  it('pins a managed account rather than following later active-account selection', async () => {
    const { state, deps, readCredentials } = rig()
    const reference = await bindProtectedClaudeAuth(
      { kind: 'managed-oauth', accountId: MANAGED.id },
      deps
    )
    expect(reference).toEqual({
      kind: 'managed-oauth',
      accountId: MANAGED.id,
      configDir: MANAGED.managedAuthPath,
      email: MANAGED.email,
      organizationUuid: 'org-a'
    })
    expect(JSON.stringify(reference)).not.toContain('fake-oauth')
    state.active = 'another-account'
    state.credentials = { ...state.credentials, token: 'fake-oauth-rotated' }
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-rotated'
    })
    expect(readCredentials).toHaveBeenLastCalledWith({
      credentialsFileConfigDir: MANAGED.managedAuthPath,
      keychainConfigDir: MANAGED.managedAuthPath,
      unsuffixedKeychainFallback: false
    })
  })

  it.each(['missing', 'home', 'email', 'organization', 'organization-null'] as const)(
    'refuses managed %s drift instead of using environment or System default',
    async (change) => {
      const { state, deps, readCredentials } = rig()
      const reference = await bindProtectedClaudeAuth(
        { kind: 'managed-oauth', accountId: MANAGED.id },
        deps
      )
      readCredentials.mockClear()
      if (change === 'missing') {
        state.accounts = []
      }
      if (change === 'home') {
        state.accounts = [{ ...MANAGED, managedAuthPath: '/fake/other-home' }]
      }
      if (change === 'email') {
        state.login = {
          email: 'other@example.test',
          organizationUuid: 'org-a',
          organizationName: null
        }
      }
      if (change === 'organization') {
        state.login = { email: MANAGED.email, organizationUuid: 'org-b', organizationName: null }
      }
      if (change === 'organization-null') {
        state.login = { email: MANAGED.email, organizationUuid: null, organizationName: null }
      }
      vi.stubEnv('ANTHROPIC_API_KEY', 'fake-ambient-key')
      await expect(readProtectedClaudeAuth(reference, deps)).rejects.toThrow()
      expect(
        readCredentials.mock.calls.every(
          ([options]) => options?.unsuffixedKeychainFallback === false
        )
      ).toBe(true)
    }
  )

  it('refuses missing managed credentials even when saved environment credentials exist', async () => {
    const { state, deps, readCredentials } = rig()
    const reference = await bindProtectedClaudeAuth(
      { kind: 'managed-oauth', accountId: MANAGED.id },
      deps
    )
    state.credentials = { token: null, hasRefreshableCredentials: false, source: 'none' }
    readCredentials.mockClear()
    await expect(readProtectedClaudeAuth(reference, deps)).rejects.toThrow()
    expect(readCredentials).toHaveBeenCalledTimes(1)
    expect(readCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialsFileConfigDir: MANAGED.managedAuthPath,
        unsuffixedKeychainFallback: false
      })
    )
  })

  it('permits unsuffixed Keychain fallback only for explicitly bound System default', async () => {
    const { deps, readCredentials } = rig()
    const reference = await bindProtectedClaudeAuth(DEFAULT_SOURCE, deps)
    expect(reference).toMatchObject({
      ...DEFAULT_SOURCE,
      email: MANAGED.email,
      organizationUuid: 'org-a'
    })
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-one'
    })
    expect(readCredentials).toHaveBeenLastCalledWith({
      credentialsFileConfigDir: DEFAULT_SOURCE.configDir,
      keychainConfigDir: DEFAULT_SOURCE.configDir,
      unsuffixedKeychainFallback: true
    })
  })

  it.each([
    ['configDir', { configDir: '/fake/elsewhere/.claude' }],
    ['stateFile', { stateFile: '/fake/elsewhere/.claude.json' }]
  ] as const)(
    'refuses a System default whose %s is not under its pinned user home',
    async (_name, change) => {
      const { deps, readLogin, readCredentials } = rig()
      await expect(bindProtectedClaudeAuth({ ...DEFAULT_SOURCE, ...change }, deps)).rejects.toThrow(
        'protected_claude_auth_unavailable'
      )
      expect(readLogin).not.toHaveBeenCalled()
      expect(readCredentials).not.toHaveBeenCalled()
    }
  )

  it('never pairs an OAuth credential with a saved or ambient custom model URL', async () => {
    const { deps } = rig()
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unrelated.example.test')
    const reference = await bindProtectedClaudeAuth(
      { kind: 'managed-oauth', accountId: MANAGED.id },
      deps
    )
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-one'
    })
  })

  it('binds the saved logical slot, accepts same-slot rotation, and exports only the selected credential and endpoint', async () => {
    const { state, deps, readCredentials, readLogin } = rig()
    const reference = await bindProtectedClaudeAuth(
      { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' },
      deps
    )
    expect(reference).toEqual({
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://model.example.test/v1'
    })
    expect(JSON.stringify(reference)).not.toContain('fake-key')
    expect(JSON.stringify(reference)).not.toContain('fingerprint')
    state.savedEnv.ANTHROPIC_API_KEY = 'fake-key-rotated'
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      ANTHROPIC_API_KEY: 'fake-key-rotated',
      ANTHROPIC_BASE_URL: 'https://model.example.test/v1'
    })
    expect(readCredentials).not.toHaveBeenCalled()
    expect(readLogin).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'credential-key', 'empty'] as const)(
    'refuses saved %s drift',
    async (change) => {
      const { state, deps } = rig()
      const reference = await bindProtectedClaudeAuth(
        { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' },
        deps
      )
      if (change === 'endpoint') {
        state.savedEnv.ANTHROPIC_BASE_URL = 'https://other.example.test'
      }
      if (change === 'credential-key') {
        state.savedEnv = {
          ANTHROPIC_AUTH_TOKEN: 'fake-other-key',
          ANTHROPIC_BASE_URL: reference.baseUrl
        }
      }
      if (change === 'empty') {
        state.savedEnv.ANTHROPIC_API_KEY = ''
      }
      await expect(readProtectedClaudeAuth(reference, deps)).rejects.toThrow()
    }
  )

  it('refuses an ambiguous saved map unless the host explicitly chooses its credential key', async () => {
    const { state, deps } = rig()
    state.savedEnv.ANTHROPIC_AUTH_TOKEN = 'fake-second-key'
    await expect(bindProtectedClaudeAuth({ kind: 'saved-agent-env' }, deps)).rejects.toThrow()
    const reference = await bindProtectedClaudeAuth(
      { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_AUTH_TOKEN' },
      deps
    )
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'fake-second-key',
      ANTHROPIC_BASE_URL: state.savedEnv.ANTHROPIC_BASE_URL
    })
  })

  it('does not pair a saved key with an ambient URL when its own map has no URL', async () => {
    const { state, deps } = rig()
    delete state.savedEnv.ANTHROPIC_BASE_URL
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.example.test')
    const reference = await bindProtectedClaudeAuth(
      { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' },
      deps
    )
    expect(reference.baseUrl).toBe('https://api.anthropic.com')
    expect(await readProtectedClaudeAuth(reference, deps)).toEqual({
      ANTHROPIC_API_KEY: 'fake-key-one',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
    })
  })

  it.each([
    'https://user:fake@api.test',
    'https://api.test/?key=fake',
    'file:///fake/socket',
    'https://api.test/#fragment'
  ])('refuses unsafe endpoint %s', async (endpoint) => {
    const { state, deps } = rig()
    state.savedEnv.ANTHROPIC_BASE_URL = endpoint
    await expect(
      bindProtectedClaudeAuth({ kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' }, deps)
    ).rejects.toThrow()
  })
})
