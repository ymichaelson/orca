import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { foundAgentSessionRecord } from '../runtime/agent-session-record-founding'
import type { ProtectedClaudeExecutable } from './claude-protected-native-profile'
import { createProtectedClaudeLaunchResolver } from './claude-protected-launch-resolution'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-protected-resolve-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function rig(resume = true) {
  const original = agentSessionRecordFixture()
  const privateRoot = join(root, 'state', 'forge-protected-analysis', original.sessionId)
  const profile = protectedClaudeLaunchFixture(privateRoot)
  for (const name of ['home', 'config', 'work']) {
    await mkdir(join(privateRoot, name), { recursive: true })
  }
  const initial = resume
    ? original
    : foundAgentSessionRecord(original, { claimKeyId: 'key-1', now: 100 })
  let record: AgentSessionRecord = {
    ...initial,
    schemaVersion: 3,
    protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
    accountHome: {
      variable: 'CLAUDE_CONFIG_DIR',
      path: join(privateRoot, 'config')
    },
    launchDirectory: join(root, 'original-workspace'),
    protectedClaudeLaunch: profile,
    options: { model: 'opus' }
  }
  const ordinary = vi.fn(async () => {
    throw new Error('Ordinary launch must not run')
  })
  const readAuth = vi.fn(async () => ({
    ANTHROPIC_API_KEY: 'fake-pinned-key',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
  }))
  const inspectExecutable = vi.fn(
    async (): Promise<ProtectedClaudeExecutable> => profile.executable
  )
  const hasTranscript = vi.fn(async () => true)
  const resolve = createProtectedClaudeLaunchResolver({
    store: { getRecord: () => record },
    stateDirectory: join(root, 'state'),
    scanRoots: [join(root, 'ordinary', '.claude')],
    ordinary,
    readAuth,
    inspectExecutable,
    hasTranscript
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: record.location.executionHostId,
    agent: record.provider,
    providerHandle: resume ? (original.providerHandleChain[0]?.handle ?? null) : null
  }
  return {
    resolve,
    identity,
    profile,
    ordinary,
    readAuth,
    inspectExecutable,
    hasTranscript,
    record: () => record,
    replace: (next: AgentSessionRecord) => {
      record = next
    }
  }
}

describe('protected launch resolution retains the existing durable native session', () => {
  it.each(['folder', 'git-worktree'] as const)(
    'resumes the exact native handle and private home while preserving original %s context',
    async (workspaceKind) => {
      const state = await rig()
      state.replace({ ...state.record(), location: { ...state.record().location, workspaceKind } })
      const before = structuredClone(state.record())
      const result = await state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
      expect(result).toMatchObject({
        protectedClaudeLaunch: state.profile,
        pathToClaudeCodeExecutable: state.profile.executable.path,
        cwd: join(state.profile.privateRoot, 'work'),
        claudeConfigDir: join(state.profile.privateRoot, 'config'),
        providerSessionId: 'provider-session-alpha-1',
        resumesTranscript: true,
        continuesChain: true,
        options: {
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          plugins: [],
          verbatimPrompts: true,
          resume: 'provider-session-alpha-1'
        },
        env: {
          HOME: join(state.profile.privateRoot, 'home'),
          CLAUDE_CONFIG_DIR: join(state.profile.privateRoot, 'config'),
          ANTHROPIC_API_KEY: 'fake-pinned-key'
        }
      })
      expect(state.record()).toEqual(before)
      expect(state.ordinary).not.toHaveBeenCalled()
      expect(state.hasTranscript).toHaveBeenCalledWith({
        providerSessionId: 'provider-session-alpha-1',
        claudeConfigDir: join(state.profile.privateRoot, 'config')
      })
    }
  )

  it('refuses a missing required protected transcript rather than starting an empty conversation', async () => {
    const state = await rig()
    state.hasTranscript.mockResolvedValue(false)
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('allows an honestly fresh founded record with an empty handle chain', async () => {
    const state = await rig(false)
    state.hasTranscript.mockResolvedValue(false)
    const result = await state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    expect(result.resumesTranscript).toBe(false)
    expect(result.options.sessionId).toBe(result.providerSessionId)
    expect(result.options.resume).toBeUndefined()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('rechecks the pinned binary and authentication for every acquisition', async () => {
    const state = await rig()
    await state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    state.inspectExecutable.mockRejectedValueOnce(new Error('unknown fingerprint'))
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-b' })
    ).rejects.toThrow('unknown fingerprint')
    expect(state.inspectExecutable).toHaveBeenCalledTimes(2)
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('does not turn failed authentication into an ordinary-account retry', async () => {
    const state = await rig()
    state.readAuth.mockRejectedValue(new Error('pinned account drift'))
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow('pinned account drift')
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('refuses a missing private work directory before resolving credentials', async () => {
    const state = await rig()
    await rm(join(state.profile.privateRoot, 'work'), { recursive: true })
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow()
    expect(state.readAuth).not.toHaveBeenCalled()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a symlinked private work directory and leaves the target untouched',
    async () => {
      const state = await rig()
      const canary = join(root, 'canary-target')
      await mkdir(canary)
      await writeFile(join(canary, 'keep.txt'), 'user data')
      const work = join(state.profile.privateRoot, 'work')
      await rm(work, { recursive: true })
      await symlink(canary, work)
      await expect(
        state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
      ).rejects.toThrow('protected_claude_launch_unavailable')
      expect(state.readAuth).not.toHaveBeenCalled()
      expect(await readFile(join(canary, 'keep.txt'), 'utf8')).toBe('user data')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a group-writable private config directory',
    async () => {
      const state = await rig()
      await chmod(join(state.profile.privateRoot, 'config'), 0o770)
      await expect(
        state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
      ).rejects.toThrow('protected_claude_launch_unavailable')
      expect(state.readAuth).not.toHaveBeenCalled()
    }
  )

  it('refuses an executable that no longer matches the pinned path and fingerprint', async () => {
    const state = await rig()
    state.inspectExecutable.mockResolvedValueOnce({
      ...state.profile.executable,
      sha256: 'a'.repeat(64)
    })
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow()
    expect(state.readAuth).not.toHaveBeenCalled()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('rejects a different native handle before resolving credentials', async () => {
    const state = await rig()
    await expect(
      state.resolve({
        identity: { ...state.identity, providerHandle: claudeProviderHandle('other-chain', null) },
        spawnToken: 'spawn-a'
      })
    ).rejects.toThrow()
    expect(state.readAuth).not.toHaveBeenCalled()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('rejects a clear-chain boundary instead of dropping protected history', async () => {
    const state = await rig()
    state.replace({
      ...state.record(),
      providerContextBoundary: { operationId: 'clear-a', afterFence: 7, clearedAt: 200 }
    })
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow()
    expect(state.ordinary).not.toHaveBeenCalled()
  })

  it('refuses unsupported WSL runtime before any auth or ordinary path', async () => {
    const state = await rig()
    state.replace({
      ...state.record(),
      location: { ...state.record().location, wslDistro: 'Ubuntu' }
    })
    await expect(
      state.resolve({ identity: state.identity, spawnToken: 'spawn-a' })
    ).rejects.toThrow()
    expect(state.readAuth).not.toHaveBeenCalled()
    expect(state.ordinary).not.toHaveBeenCalled()
  })
})
