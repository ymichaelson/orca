import { describe, expect, it } from 'vitest'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  PROTECTED_CLAUDE_PROFILE,
  protectedClaudePrivatePath
} from '../../shared/agent-session-protected-claude-launch'
import {
  isForgeProtectedSessionFor,
  type ForgeProtectedSessionRecord
} from './forge-inbox-protected-session-binding'

const OWNER = '6f1c1f0e-2a5c-4b1e-9b0e-0a1b2c3d4e5f'
const SESSION = 'protected-session'

const SUBJECT: AgentSessionProtectedAnalysis = {
  ownerId: OWNER,
  instanceId: 'gitlab-main',
  itemId: '7',
  analysisKind: 'merge_request'
}

function protectedLaunch(privateRoot: string) {
  return {
    version: 1,
    profile: PROTECTED_CLAUDE_PROFILE,
    executable: {
      path: '/opt/claude/claude',
      platform: 'darwin-arm64',
      sha256: PROTECTED_CLAUDE_NATIVE_HASHES['darwin-arm64']
    },
    privateRoot,
    auth: {
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com'
    }
  }
}

function record(
  subject: AgentSessionProtectedAnalysis = SUBJECT,
  overrides: Partial<ForgeProtectedSessionRecord> = {}
): ForgeProtectedSessionRecord {
  const privateRoot = `/state/forge-protected-analysis/${SESSION}`
  return {
    schemaVersion: 3,
    provider: 'claude',
    accountHome: {
      variable: 'CLAUDE_CONFIG_DIR',
      path: protectedClaudePrivatePath(privateRoot, 'config')
    },
    options: { model: 'claude-protected-analysis' },
    protectedAnalysis: subject,
    protectedClaudeLaunch: protectedLaunch(privateRoot),
    lease: { runtimeFence: 7 },
    ...overrides
  }
}

describe('forge protected session binding', () => {
  it('accepts a record that proves this exact item launched protected', () => {
    expect(isForgeProtectedSessionFor(record(), SUBJECT)).toBe(true)
  })

  it('rejects a record with no protected launch marker', () => {
    expect(
      isForgeProtectedSessionFor(record(SUBJECT, { protectedClaudeLaunch: undefined }), SUBJECT)
    ).toBe(false)
  })

  it('rejects a record founded for another item', () => {
    const other = { ...SUBJECT, itemId: '8' }
    expect(isForgeProtectedSessionFor(record(other), SUBJECT)).toBe(false)
  })

  it('rejects a record founded on another host instance', () => {
    const other = { ...SUBJECT, instanceId: 'gitlab-other' }
    expect(isForgeProtectedSessionFor(record(other), SUBJECT)).toBe(false)
  })

  it('rejects a record that is not the protected claude binding', () => {
    expect(isForgeProtectedSessionFor(record(SUBJECT, { provider: 'codex' }), SUBJECT)).toBe(false)
    expect(isForgeProtectedSessionFor(record(SUBJECT, { schemaVersion: 2 }), SUBJECT)).toBe(false)
  })

  it('rejects a malformed launch marker', () => {
    expect(
      isForgeProtectedSessionFor(
        record(SUBJECT, { protectedClaudeLaunch: { version: 1 } }),
        SUBJECT
      )
    ).toBe(false)
  })
})
