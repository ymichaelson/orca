import { join } from 'node:path'
import {
  isProtectedClaudeRecordBinding,
  type ProtectedClaudeAuthReference
} from '../../shared/agent-session-protected-claude-launch'
import { agentSessionProviderHandleRoot } from '../../shared/agent-session-provider-handle'
import { claudeProviderHandleLeafUuid } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { StructuredLaunchRequest } from '../runtime/structured-agent-launch-composition'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  admitProtectedClaudePrivateRoot,
  inspectProtectedClaudeNativeArtifact,
  protectedClaudeExecutableMatches,
  protectedClaudePrivateDirectoriesAdmitted,
  type ProtectedClaudeExecutable
} from './claude-protected-native-profile'
import { protectedClaudeProcessEnvironment } from './claude-protected-process-seal'
import {
  claudeSessionIdForOrcaSession,
  type ClaudeStructuredLaunch
} from './claude-structured-launch-resolution'

export type ProtectedClaudeLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  stateDirectory: string
  scanRoots: readonly string[] | (() => readonly string[] | Promise<readonly string[]>)
  ordinary: (input: StructuredLaunchRequest) => Promise<ClaudeStructuredLaunch>
  readAuth: (reference: ProtectedClaudeAuthReference) => Promise<Record<string, string>>
  inspectExecutable?: (path: string, platform: string) => Promise<ProtectedClaudeExecutable>
  hasTranscript?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<boolean>
}
function unavailable(): never {
  throw new Error('protected_claude_launch_unavailable')
}
async function hasTranscript(input: {
  providerSessionId: string
  claudeConfigDir: string
}): Promise<boolean> {
  return (
    (await resolveSessionFilePath('claude', input.providerSessionId, {
      claudeProjectsDir: join(input.claudeConfigDir, 'projects')
    })) !== null
  )
}

export function createProtectedClaudeLaunchResolver(deps: ProtectedClaudeLaunchResolverDeps) {
  return async (input: StructuredLaunchRequest): Promise<ClaudeStructuredLaunch> => {
    const record = deps.store.getRecord(input.identity.sessionId)
    if (!record) {
      return unavailable()
    }
    if (!record.protectedAnalysis && !record.protectedClaudeLaunch) {
      return deps.ordinary(input)
    }
    if (
      !record.protectedClaudeLaunch ||
      !isProtectedClaudeRecordBinding(record) ||
      record.location.wslDistro !== null ||
      record.providerContextBoundary ||
      record.rewind ||
      input.identity.agent !== 'claude' ||
      input.identity.workspaceId !== record.location.workspaceId ||
      input.identity.hostId !== record.location.executionHostId ||
      (input.permissionMode && input.permissionMode !== 'ask')
    ) {
      return unavailable()
    }
    const profile = record.protectedClaudeLaunch
    if (
      profile.privateRoot !==
      join(deps.stateDirectory, 'forge-protected-analysis', record.sessionId)
    ) {
      return unavailable()
    }
    const head = record.providerHandleChain.at(-1)?.handle
    if (
      record.providerHandleChain.some(
        (link) => link.origin === 'forked' || link.replaces || link.supersedesKey
      ) ||
      (head &&
        (head.agent !== 'claude' ||
          head.transport !== 'claude-sdk' ||
          !input.identity.providerHandle ||
          agentSessionProviderHandleRoot(input.identity.providerHandle) !==
            agentSessionProviderHandleRoot(head))) ||
      (!head && input.identity.providerHandle)
    ) {
      return unavailable()
    }
    const roots = typeof deps.scanRoots === 'function' ? await deps.scanRoots() : deps.scanRoots
    await admitProtectedClaudePrivateRoot({ privateRoot: profile.privateRoot, scanRoots: roots })
    const cwd = join(profile.privateRoot, 'work')
    if (!(await protectedClaudePrivateDirectoriesAdmitted(profile.privateRoot))) {
      return unavailable()
    }
    const executable = await (deps.inspectExecutable ?? inspectProtectedClaudeNativeArtifact)(
      profile.executable.path,
      profile.executable.platform
    )
    if (!protectedClaudeExecutableMatches(executable, profile.executable)) {
      return unavailable()
    }
    const providerSessionId = head?.nativeId ?? claudeSessionIdForOrcaSession(record.sessionId)
    const claudeConfigDir = join(profile.privateRoot, 'config')
    if (
      head &&
      !(await (deps.hasTranscript ?? hasTranscript)({ providerSessionId, claudeConfigDir }))
    ) {
      return unavailable()
    }
    const auth = await deps.readAuth(profile.auth)
    const env = protectedClaudeProcessEnvironment({
      protectedClaudeLaunch: profile,
      env: {
        ...auth,
        PATH:
          process.platform === 'win32'
            ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
            : '/usr/bin:/bin',
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
          : {}),
        ORCA_AGENT_SESSION_ID: record.sessionId,
        ORCA_AGENT_SESSION_SPAWN_TOKEN: input.spawnToken,
        ORCA_STRUCTURED_SESSION: '1'
      }
    })
    return {
      protectedClaudeLaunch: profile,
      pathToClaudeCodeExecutable: executable.path,
      cwd,
      env,
      claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: head ? claudeProviderHandleLeafUuid(head) : null,
      resumesTranscript: Boolean(head),
      continuesChain: Boolean(head),
      options: {
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        extraArgs: { 'replay-user-messages': null },
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        plugins: [],
        supportedDialogKinds: [],
        verbatimPrompts: true,
        permissionMode: 'default',
        model: record.options?.model,
        ...(head ? { resume: providerSessionId } : { sessionId: providerSessionId })
      }
    }
  }
}
