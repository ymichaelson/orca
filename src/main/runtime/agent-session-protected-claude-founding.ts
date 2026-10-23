import { mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isAgentSessionId,
  type AgentSessionExecutionLocation
} from '../../shared/agent-session-record'
import {
  isProtectedClaudeModel,
  PROTECTED_CLAUDE_PROFILE,
  protectedClaudeLaunchSchema
} from '../../shared/agent-session-protected-claude-launch'
import {
  bindProtectedClaudeAuth,
  type ProtectedClaudeAuthDeps,
  type ProtectedClaudeAuthSource
} from '../claude/claude-protected-auth'
import {
  admitProtectedClaudePrivateRoot,
  inspectProtectedClaudeNativeArtifact,
  type ProtectedClaudeExecutable
} from '../claude/claude-protected-native-profile'

export type ProtectedClaudeFoundingInput = {
  sessionId: string
  provider: string
  model: string
  location: AgentSessionExecutionLocation
  launchDirectory: string
  authSource: ProtectedClaudeAuthSource
}
export type ProtectedClaudeFoundingDeps = {
  stateDirectory: string
  scanRoots: readonly string[]
  auth: ProtectedClaudeAuthDeps
  resolveExecutablePath?: () => Promise<string>
  inspectExecutable?: (path: string) => Promise<ProtectedClaudeExecutable>
}

async function installedNativePath(): Promise<string> {
  return realpath(join(homedir(), '.local', 'share', 'claude', 'versions', '2.1.302'))
}

export async function prepareProtectedClaudeFounding(
  input: ProtectedClaudeFoundingInput,
  deps: ProtectedClaudeFoundingDeps
) {
  if (
    !isAgentSessionId(input.sessionId) ||
    input.provider !== 'claude' ||
    input.location.wslDistro !== null ||
    !isProtectedClaudeModel(input.model) ||
    !input.authSource
  ) {
    throw new Error('protected_claude_founding_unavailable')
  }
  const auth = await bindProtectedClaudeAuth(input.authSource, deps.auth)
  const executable = await (deps.inspectExecutable ?? inspectProtectedClaudeNativeArtifact)(
    await (deps.resolveExecutablePath ?? installedNativePath)()
  )
  const privateRoot = join(deps.stateDirectory, 'forge-protected-analysis', input.sessionId)
  await admitProtectedClaudePrivateRoot({ privateRoot, scanRoots: deps.scanRoots })
  const parsed = protectedClaudeLaunchSchema.safeParse({
    version: 1,
    profile: PROTECTED_CLAUDE_PROFILE,
    executable,
    privateRoot,
    auth
  })
  if (!parsed.success) {
    throw new Error('protected_claude_founding_unavailable')
  }
  await mkdir(join(deps.stateDirectory, 'forge-protected-analysis'), {
    recursive: true,
    mode: 0o700
  })
  await mkdir(privateRoot, { mode: 0o700 })
  try {
    for (const name of ['home', 'config', 'work']) {
      await mkdir(join(privateRoot, name), { mode: 0o700 })
    }
    await admitProtectedClaudePrivateRoot({ privateRoot, scanRoots: deps.scanRoots })
    return {
      protectedClaudeLaunch: parsed.data,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: join(privateRoot, 'config') },
      options: { model: input.model }
    }
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true })
    throw error
  }
}
