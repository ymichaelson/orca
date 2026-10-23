// A protected analysis can spawn Task subagents, and their transcripts carry more of the same
// untrusted MR text. A reader that is not shown the parent row is not shown its children.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  installOwnership,
  PROVIDER_SESSION
} from '../ai-vault/structured-session-ownership.test-support'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'

const ROOT = '/sessions/claude/projects'
const { listSubagents } = vi.hoisted(() => ({
  listSubagents: vi.fn(async () => ({ sessions: [], issues: [] }))
}))

vi.mock('../ai-vault/cached-session-list', () => ({ getAiVaultWslHomeDirs: async () => [] }))
vi.mock('../ai-vault/session-scanner-roots', () => ({
  claudeProjectsRootDirs: () => [ROOT],
  ompSessionsRootDirs: () => [ROOT]
}))
vi.mock('../ai-vault/session-scanner-background', () => ({
  listAiVaultSubagentSessionsInBackground: listSubagents
}))

const parentPath = `${ROOT}/${PROVIDER_SESSION}.jsonl`

afterEach(() => setStructuredAgentSessionHost(null))

describe('listAiVaultSubagentSessions', () => {
  it('lists nothing under a protected analysis', async () => {
    installOwnership({ protected: true, handle: claudeProviderHandle(PROVIDER_SESSION, null) })

    await expect(
      listAiVaultSubagentSessions({ agent: 'claude', parentFilePath: parentPath })
    ).resolves.toEqual({ sessions: [], issues: [] })
    expect(listSubagents).not.toHaveBeenCalled()
  })

  it('lists the subagents of an ordinary chat', async () => {
    installOwnership({ handle: claudeProviderHandle(PROVIDER_SESSION, null) })

    await listAiVaultSubagentSessions({ agent: 'claude', parentFilePath: parentPath })

    expect(listSubagents).toHaveBeenCalledWith({
      agent: 'claude',
      parentFilePath: parentPath
    })
  })
})
