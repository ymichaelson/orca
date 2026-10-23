import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import {
  hasProtectedClaudeControlCharacter,
  canonicalProtectedClaudeEndpoint,
  protectedClaudePrivatePath,
  protectedClaudeLaunchSchema,
  type ProtectedClaudeLaunchV1
} from '../../shared/agent-session-protected-claude-launch'

export type ProtectedClaudeProcessSeal = {
  protectedClaudeLaunch: ProtectedClaudeLaunchV1
  env: Record<string, string>
  model?: string
  sessionId?: string
  resumesTranscript?: boolean
}
function unavailable(): never {
  throw new Error('protected_claude_process_refused')
}
const OS_KEYS = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'])
const LEASE_KEYS = new Set([
  'ORCA_AGENT_SESSION_ID',
  'ORCA_AGENT_SESSION_SPAWN_TOKEN',
  'ORCA_STRUCTURED_SESSION'
])

export function protectedClaudeProcessEnvironment(
  seal: ProtectedClaudeProcessSeal
): Record<string, string> {
  const profile = protectedClaudeLaunchSchema.safeParse(seal.protectedClaudeLaunch)
  if (!profile.success) {
    return unavailable()
  }
  const env: Record<string, string> = {}
  const folded = new Set<string>()
  for (const [key, value] of Object.entries(seal.env)) {
    const upper = key.toUpperCase()
    if (!OS_KEYS.has(upper) && !LEASE_KEYS.has(upper)) {
      continue
    }
    if (folded.has(upper) || hasProtectedClaudeControlCharacter(value)) {
      return unavailable()
    }
    folded.add(upper)
    env[key] = value
  }
  const auth = profile.data.auth
  const key = auth.kind === 'saved-agent-env' ? auth.credentialKey : 'CLAUDE_CODE_OAUTH_TOKEN'
  const credential = seal.env[key]
  if (!credential || hasProtectedClaudeControlCharacter(credential)) {
    return unavailable()
  }
  env[key] = credential
  if (auth.kind === 'saved-agent-env') {
    if (
      canonicalProtectedClaudeEndpoint(
        seal.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
      ) !== auth.baseUrl
    ) {
      return unavailable()
    }
    env.ANTHROPIC_BASE_URL = auth.baseUrl
  }
  const home = protectedClaudePrivatePath(profile.data.privateRoot, 'home')
  env.HOME = home
  if (profile.data.executable.platform === 'win32-x64') {
    // os.homedir() and app-data lookups read these on Windows, never HOME.
    env.USERPROFILE = home
    env.APPDATA = home
    env.LOCALAPPDATA = home
  }
  env.CLAUDE_CONFIG_DIR = protectedClaudePrivatePath(profile.data.privateRoot, 'config')
  env.CLAUDE_CODE_SIMPLE = '1'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.DISABLE_TELEMETRY = '1'
  env.DISABLE_ERROR_REPORTING = '1'
  return env
}

function admittedArguments(args: readonly string[], seal: ProtectedClaudeProcessSeal): void {
  const seen = new Map<string, string | null>()
  const switches = new Set([
    '--verbose',
    '--strict-mcp-config',
    '--include-partial-messages',
    '--replay-user-messages'
  ])
  const values = new Set([
    '--output-format',
    '--input-format',
    '--tools',
    '--setting-sources',
    '--mcp-config',
    '--permission-mode',
    '--permission-prompt-tool',
    '--model',
    '--resume',
    '--session-id'
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) {
      return unavailable()
    }
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (seen.has(flag)) {
      return unavailable()
    }
    if (switches.has(flag)) {
      if (equals !== -1) {
        return unavailable()
      }
      seen.set(flag, null)
    } else if (values.has(flag)) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1)
      if (value === undefined || hasProtectedClaudeControlCharacter(value)) {
        return unavailable()
      }
      seen.set(flag, value)
    } else {
      return unavailable()
    }
  }
  for (const [flag, value] of [
    ['--output-format', 'stream-json'],
    ['--input-format', 'stream-json'],
    ['--tools', ''],
    ['--setting-sources', ''],
    ['--strict-mcp-config', null]
  ] as const) {
    if (seen.get(flag) !== value) {
      return unavailable()
    }
  }
  if (seen.has('--mcp-config') && seen.get('--mcp-config') !== '{"mcpServers":{}}') {
    return unavailable()
  }
  if (seen.has('--permission-mode') && seen.get('--permission-mode') !== 'default') {
    return unavailable()
  }
  if (seen.has('--permission-prompt-tool') && seen.get('--permission-prompt-tool') !== 'stdio') {
    return unavailable()
  }
  if (seal.model && seen.get('--model') !== seal.model) {
    return unavailable()
  }
  if (seal.sessionId) {
    const expected = seal.resumesTranscript ? '--resume' : '--session-id'
    if (
      seen.get(expected) !== seal.sessionId ||
      seen.has(seal.resumesTranscript ? '--session-id' : '--resume')
    ) {
      return unavailable()
    }
  } else if (seen.has('--resume') && seen.has('--session-id')) {
    return unavailable()
  }
}

export function sealProtectedClaudeSpawn(
  options: SpawnOptions,
  seal: ProtectedClaudeProcessSeal
): Record<string, string> {
  if (
    options.command !== seal.protectedClaudeLaunch.executable.path ||
    options.cwd !== protectedClaudePrivatePath(seal.protectedClaudeLaunch.privateRoot, 'work')
  ) {
    return unavailable()
  }
  admittedArguments(options.args, seal)
  return protectedClaudeProcessEnvironment(seal)
}

export function protectedClaudeSealForLaunch(launch: {
  protectedClaudeLaunch?: ProtectedClaudeLaunchV1
  env?: Record<string, string>
  options: { model?: string; resume?: string; sessionId?: string }
}): ProtectedClaudeProcessSeal | undefined {
  return (
    launch.protectedClaudeLaunch && {
      protectedClaudeLaunch: launch.protectedClaudeLaunch,
      env: launch.env ?? {},
      model: launch.options.model,
      sessionId: launch.options.resume ?? launch.options.sessionId,
      resumesTranscript: launch.options.resume !== undefined
    }
  )
}
