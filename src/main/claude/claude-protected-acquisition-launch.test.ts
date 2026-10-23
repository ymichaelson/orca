import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { protectedClaudeLaunchFixture } from '../../shared/agent-session-protected-claude-launch.test-fixture'
import type { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

const PROFILE = protectedClaudeLaunchFixture()
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-protected',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: null
}

function adapter(openConnection: typeof openClaudeStreamJsonConnection) {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      protectedClaudeLaunch: PROFILE,
      pathToClaudeCodeExecutable: PROFILE.executable.path,
      options: { model: 'opus' },
      cwd: `${PROFILE.privateRoot}/work`,
      claudeConfigDir: `${PROFILE.privateRoot}/config`,
      providerSessionId: '819cf9f8-e43c-4ad7-b50f-54aa158a726a',
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection
  })
}

describe('protected Claude acquisition', () => {
  it('hands the durable protected profile to the connection it opens', async () => {
    const open = vi.fn<typeof openClaudeStreamJsonConnection>(async () => {
      throw new Error('stop after capturing the launch')
    })
    await adapter(open)
      .acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-1' })
      .catch(() => {})
    expect(open.mock.calls[0]?.[0]).toMatchObject({ protectedClaudeLaunch: PROFILE })
  })

  it('refuses a saved override before any child is opened', async () => {
    const open = vi.fn<typeof openClaudeStreamJsonConnection>()
    await expect(
      adapter(open).acquire({
        identity: IDENTITY,
        fence: 7,
        spawnToken: 'spawn-2',
        options: { model: 'another-model' }
      })
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})
