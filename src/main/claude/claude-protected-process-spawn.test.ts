import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { protectedClaudeLaunchFixture } from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import {
  fakeProtectedSdkProcess,
  nativeEnvironment
} from './claude-protected-sdk-process.test-fixture'

const PROFILE = protectedClaudeLaunchFixture()
const SEALED_ENV = {
  HOME: `${PROFILE.privateRoot}/home`,
  CLAUDE_CONFIG_DIR: `${PROFILE.privateRoot}/config`,
  ANTHROPIC_API_KEY: 'fake-selected-model-key',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CLAUDE_CODE_SIMPLE: '1',
  PATH: '/fake/os/bin'
}
const ARGV = [
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--tools',
  '',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--permission-mode',
  'default'
]
function options(extra: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: PROFILE.executable.path,
    args: [...ARGV],
    cwd: `${PROFILE.privateRoot}/work`,
    env: { ...SEALED_ENV },
    signal: new AbortController().signal,
    ...extra
  }
}

describe('protected admission at the final SDK custom-spawn boundary', () => {
  it.each([
    ['duplicate tools', ['--tools', 'Bash']],
    ['non-strict retry', ['--strict-mcp-config=false']],
    ['project settings', ['--setting-sources', 'user,project,local']],
    ['Chrome', ['--chrome']],
    ['plugin directory', ['--plugin-dir', '/fake/plugin']],
    ['extra directory', ['--add-dir', '/fake/original-workspace']],
    ['settings hook', ['--settings', '{"hooks":{"SessionStart":[]}}']],
    ['MCP reinjection', ['--mcp-config', '{"mcpServers":{"ambient":{"command":"fake"}}}']],
    ['fork', ['--fork-session']],
    ['permission bypass', ['--permission-mode', 'bypassPermissions']]
  ])('rejects %s before the process host is called', (_label, extra) => {
    const fake = fakeProtectedSdkProcess()
    const spawner = createClaudeCodeProcessSpawn(fake.spawn, 'darwin', {
      protectedClaudeLaunch: PROFILE,
      env: SEALED_ENV
    })
    try {
      expect(() => spawner.spawn(options({ args: [...ARGV, ...extra] }))).toThrow()
      expect(fake.specs).toEqual([])
    } finally {
      fake.finish()
    }
  })

  it('rejects a substituted executable and original workspace cwd before spawning', () => {
    const fake = fakeProtectedSdkProcess()
    const spawner = createClaudeCodeProcessSpawn(fake.spawn, 'darwin', {
      protectedClaudeLaunch: PROFILE,
      env: SEALED_ENV
    })
    try {
      expect(() => spawner.spawn(options({ command: '/fake/wrapper.js' }))).toThrow()
      expect(() => spawner.spawn(options({ cwd: '/fake/original-workspace' }))).toThrow()
      expect(fake.specs).toEqual([])
    } finally {
      fake.finish()
    }
  })

  it('seals Windows environment keys case-insensitively at the actual process-host spec', () => {
    const fake = fakeProtectedSdkProcess()
    const privateRoot = 'C:\\fake\\orca\\forge-protected-analysis\\session-alpha-1'
    const profile = {
      ...PROFILE,
      privateRoot,
      executable: {
        path: 'C:\\fake\\claude.exe',
        platform: 'win32-x64',
        sha256: '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae'
      }
    } as const
    const env = {
      HOME: `${privateRoot}\\home`,
      CLAUDE_CONFIG_DIR: `${privateRoot}\\config`,
      ANTHROPIC_API_KEY: 'fake-selected-model-key',
      CLAUDE_CODE_SIMPLE: '1',
      SystemRoot: 'C:\\Windows'
    }
    const spawner = createClaudeCodeProcessSpawn(fake.spawn, 'win32', {
      protectedClaudeLaunch: profile,
      env
    })
    try {
      spawner.spawn(
        options({
          command: profile.executable.path,
          cwd: `${privateRoot}\\work`,
          env: {
            ...env,
            Home: 'C:\\fake\\ambient-home',
            UserProfile: 'C:\\Users\\fake-real',
            AppData: 'C:\\Users\\fake-real\\AppData\\Roaming',
            anthropic_auth_token: 'fake-ambient',
            Node_Options: '--require=fake',
            TraceParent: 'fake-trace',
            GitLab_Token: 'fake-forge'
          }
        })
      )
      const spec = fake.specs[0]
      if (!spec) {
        throw new Error('No fake Windows process spec')
      }
      const final = nativeEnvironment(spec)
      expect(final).toMatchObject(env)
      expect(Object.keys(final).filter((key) => key.toLowerCase() === 'home')).toEqual(['HOME'])
      for (const name of ['userprofile', 'appdata', 'localappdata']) {
        expect(Object.keys(final).filter((key) => key.toLowerCase() === name)).toHaveLength(1)
      }
      expect(final).toMatchObject({
        USERPROFILE: `${privateRoot}\\home`,
        APPDATA: `${privateRoot}\\home`,
        LOCALAPPDATA: `${privateRoot}\\home`
      })
      for (const forbidden of [
        'anthropic_auth_token',
        'node_options',
        'traceparent',
        'gitlab_token'
      ]) {
        expect(Object.keys(final).map((key) => key.toLowerCase())).not.toContain(forbidden)
      }
      expect(spec).not.toMatchObject({ shell: true })
    } finally {
      fake.finish()
    }
  })
})
