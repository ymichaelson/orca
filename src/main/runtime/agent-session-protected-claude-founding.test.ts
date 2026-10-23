import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { protectedClaudeLaunchFixture } from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { journalPragmaNumber } from '../native-chat/agent-session-journal/journal-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { prepareProtectedClaudeFounding } from './agent-session-protected-claude-founding'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-protected-prepare-'))
})
afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function rig() {
  const record = agentSessionRecordFixture()
  const profile = protectedClaudeLaunchFixture(
    join(root, 'forge-protected-analysis', record.sessionId)
  )
  const input = {
    sessionId: record.sessionId,
    provider: 'claude',
    model: 'opus',
    location: { ...record.location, workspaceKind: 'folder' },
    launchDirectory: join(root, 'original-folder'),
    authSource: { kind: 'saved-agent-env', credentialKey: 'ANTHROPIC_API_KEY' }
  } as const
  const inspectExecutable = vi.fn(async () => profile.executable)
  const readLogin = vi.fn(async () => {
    throw new Error('OAuth source was not selected')
  })
  const readCredentials = vi.fn(async () => {
    throw new Error('OAuth source was not selected')
  })
  const deps = {
    stateDirectory: root,
    scanRoots: [join(root, 'ordinary', '.claude')],
    resolveExecutablePath: vi.fn(async () => profile.executable.path),
    inspectExecutable,
    auth: {
      stateDirectory: root,
      readLogin,
      readCredentials,
      getSettings: () => ({
        claudeManagedAccounts: [],
        agentDefaultEnv: {
          claude: {
            ANTHROPIC_API_KEY: 'fake-model-key',
            GITLAB_TOKEN: 'fake-forge-key',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
          }
        }
      })
    }
  }
  return { input, deps, profile, inspectExecutable, readLogin, readCredentials }
}

function version() {
  return journalPragmaNumber(openTestJournalHostDatabase(root).db, 'user_version')
}

describe('host-only protected founding preparation has no database or ordinary account side effects', () => {
  it('prepares only feature-owned inert paths and returns no-secret founding fields while DB stays at 4', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const state = rig()
    const prepared = await prepareProtectedClaudeFounding(state.input, state.deps)
    expect(prepared).toMatchObject({
      protectedClaudeLaunch: state.profile,
      accountHome: {
        variable: 'CLAUDE_CONFIG_DIR',
        path: join(state.profile.privateRoot, 'config')
      }
    })
    for (const name of ['home', 'config', 'work']) {
      expect((await stat(join(state.profile.privateRoot, name))).isDirectory()).toBe(true)
    }
    expect(JSON.stringify(prepared)).not.toContain('fake-model-key')
    expect(JSON.stringify(prepared)).not.toContain('fake-forge-key')
    expect(store.listRecords()).toEqual([])
    expect(version()).toBe(4)
    expect(state.readLogin).not.toHaveBeenCalled()
    expect(state.readCredentials).not.toHaveBeenCalled()
  })

  it('leaves the database untouched after a native audit failure and never deletes user-owned files', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const state = rig()
    const canary = join(root, 'user-settings.json')
    await writeFile(canary, '{"fake":"user-owned"}')
    state.inspectExecutable.mockRejectedValue(new Error('unknown native fingerprint'))
    await expect(prepareProtectedClaudeFounding(state.input, state.deps)).rejects.toThrow(
      'unknown native fingerprint'
    )
    expect(await readFile(canary, 'utf8')).toBe('{"fake":"user-owned"}')
    expect(store.listRecords()).toEqual([])
    expect(version()).toBe(4)
  })

  it('requires an explicit source descriptor rather than silently choosing the active/default account', async () => {
    await openTestAgentSessionRecordStore(root)
    const state = rig()
    const { authSource: _source, ...unbound } = state.input
    // @ts-expect-error -- the descriptor is required; omission must refuse rather than pick an account.
    await expect(prepareProtectedClaudeFounding(unbound, state.deps)).rejects.toThrow()
    expect(version()).toBe(4)
    expect(state.readLogin).not.toHaveBeenCalled()
    expect(state.readCredentials).not.toHaveBeenCalled()
  })
})
