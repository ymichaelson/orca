import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { foundAgentSessionRecord } from '../runtime/agent-session-record-founding'
import { createClaudeStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import * as installedRouter from '../claude-accounts/claude-profile-installed-router'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'

function rig(protectedRecord: boolean) {
  const original = agentSessionRecordFixture()
  const record = foundAgentSessionRecord(
    {
      ...original,
      ...(protectedRecord ? { protectedAnalysis: PROTECTED_ANALYSIS_MARKER } : {})
    },
    { claimKeyId: 'key-1', now: 100 }
  )
  const router = vi.spyOn(installedRouter, 'getClaudeProfileRouter').mockReturnValue(undefined)
  const environment = vi.fn(async () => ({
    PATH: '/fake/os/bin',
    GITLAB_TOKEN: 'fake-forge-canary'
  }))
  const workspace = vi.fn(async () => '/fake/original-folder')
  const command = vi.fn(() => '/fake/native/claude')
  const policy = vi.fn(() => ({ account: 'system' as const }))
  const args = vi.fn(() => [])
  const visuals = vi.fn(async () => null)
  const pin = vi.fn()
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: pin },
    resolveInheritedEnv: environment,
    resolveWorkspacePath: workspace,
    resolveCommand: command,
    resolveAuthPolicy: policy,
    resolveLaunchArgs: args,
    prepareVisuals: visuals
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: record.location.executionHostId,
    agent: record.provider,
    providerHandle: null
  }
  return {
    record,
    router,
    environment,
    workspace,
    command,
    policy,
    args,
    visuals,
    pin,
    resolve,
    identity
  }
}

afterEach(() => vi.restoreAllMocks())

describe('protected durable-record routing precedes every ordinary launch source', () => {
  it('refuses an old protected record without launch metadata before ordinary router/cwd/environment/probes', async () => {
    const state = rig(true)
    await expect(state.resolve({ identity: state.identity })).rejects.toThrow()
    for (const source of [
      state.router,
      state.environment,
      state.workspace,
      state.command,
      state.policy,
      state.args,
      state.visuals,
      state.pin
    ]) {
      expect(source).not.toHaveBeenCalled()
    }
  })

  it('continues using ordinary sources and permissions for an ordinary record', async () => {
    const state = rig(false)
    const launch = await state.resolve({ identity: state.identity })
    expect(launch.cwd).toBe('/fake/original-folder')
    expect(launch.options.settingSources).toEqual(['user', 'project', 'local'])
    expect(launch.options.permissionMode).toBe('default')
    expect(state.router).toHaveBeenCalled()
    expect(state.environment).toHaveBeenCalled()
    expect(state.command).toHaveBeenCalled()
    expect(state.policy).toHaveBeenCalled()
  })
})

describe('saved options cannot override a protected profile after launch resolution', () => {
  const launch = {
    protectedClaudeLaunch: protectedClaudeLaunchFixture(),
    options: { model: 'opus', settingSources: [] },
    resumesTranscript: true
  }

  it.each([
    ['model', { model: 'unbound-model' }],
    ['settings', { fastMode: 'true' }],
    ['unknown override', { permissionMode: 'bypassPermissions' }]
  ])('rejects a saved %s override rather than silently normalizing it', (_name, saved) => {
    expect(() => claudeStructuredSpawnOptions({ launch, saved })).toThrow()
  })

  it('allows only an idempotent pinned model choice without adding settings or unsafe arguments', () => {
    const result = claudeStructuredSpawnOptions({ launch, saved: { model: 'opus' } })
    expect(result.sdkOptions).toEqual(launch.options)
    expect(result.fastModeAtStart).toBe(false)
  })

  it('keeps ordinary saved model behavior', () => {
    const { protectedClaudeLaunch: _profile, ...ordinary } = launch
    expect(
      claudeStructuredSpawnOptions({ launch: ordinary, saved: { model: 'another-model' } })
        .sdkOptions.model
    ).toBe('another-model')
  })
})
