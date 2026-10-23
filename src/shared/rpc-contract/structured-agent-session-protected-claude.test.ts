import { describe, expect, it } from 'vitest'
import { AttachParams, CreateParams, SendParams } from './structured-agent-session-params'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from '../agent-session-protected-claude-launch.test-fixture'

const envelope = {
  sessionId: 'session-alpha',
  clientOperationId: '1800000000000-00000000000000000000000000000001',
  expectedRuntimeFence: null,
  payloadFingerprint: 'a'.repeat(64)
}
const body = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Discuss this analysis' }]
}
const create = { envelope, worktree: 'id:workspace-1', agent: 'claude' }
const send = { envelope: { ...envelope, expectedRuntimeFence: 1 }, body }
const attach = {
  envelope,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  provider: 'claude',
  agent: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fake/ordinary' },
  runtimeKind: 'native',
  providerHandle: { kind: 'claude', sessionId: 'provider-alpha', leafUuid: null }
}
const HOST_ONLY = {
  protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunch: protectedClaudeLaunchFixture(),
  protectedClaudeAuthSource: { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' }
}

describe('protected launch and authentication source are never client-selectable wire inputs', () => {
  it.each([
    ['create', CreateParams, create],
    ['send', SendParams, send],
    ['attach', AttachParams, attach]
  ] as const)(
    'keeps an ordinary %s request working while rejecting each protected field',
    (_name, schema, ordinary) => {
      expect(schema.safeParse(ordinary).success).toBe(true)
      for (const [key, value] of Object.entries(HOST_ONLY)) {
        expect(schema.safeParse({ ...ordinary, [key]: value }).success, key).toBe(false)
      }
      expect(schema.safeParse({ ...ordinary, ...HOST_ONLY }).success).toBe(false)
    }
  )

  it('rejects nested protected authority on a create first message rather than silently dropping it', () => {
    const firstMessage = { clientMessageId: 'message-1', body }
    expect(CreateParams.safeParse({ ...create, firstMessage }).success).toBe(true)
    expect(
      CreateParams.safeParse({ ...create, firstMessage: { ...firstMessage, ...HOST_ONLY } }).success
    ).toBe(false)
  })
})
