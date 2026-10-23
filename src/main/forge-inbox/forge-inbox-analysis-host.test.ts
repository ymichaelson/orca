import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  protectedClaudePrivatePath
} from '../../shared/agent-session-protected-claude-launch'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionTurnCompletion
} from '../../shared/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../shared/agent-session-wire-refusals'
import type {
  AgentJournalCursor,
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ProtectedClaudeExecutable } from '../claude/claude-protected-native-profile'
import {
  createForgeInboxAnalysisHost,
  ForgeAnalysisSessionRefusedError,
  type ForgeAnalysisHostPort,
  type ForgeInboxAnalysisHostDeps
} from './forge-inbox-analysis-host'
import type { ForgeAnalysisLaunch } from './forge-inbox-analysis-launch'

const SESSION_ID = 'session-1'
const SUBJECT: AgentSessionProtectedAnalysis = {
  ownerId: '6f1c1f0e-2a5c-4b1e-9b0e-0a1b2c3d4e5f',
  instanceId: 'instance-1',
  itemId: '42',
  analysisKind: 'merge_request'
}
const LAUNCH: ForgeAnalysisLaunch = {
  instanceId: 'instance-1',
  projectId: '7',
  workspaceId: 'worktree-1',
  agentId: 'claude',
  model: 'claude-protected-analysis',
  budgets: {
    timeoutSeconds: 600,
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    maxRunsPerHour: 12,
    maxConcurrentRuns: 1
  }
}

const EXECUTABLE: ProtectedClaudeExecutable = executableFixture()
const CURSOR: AgentJournalCursor = { epoch: 'epoch-1', sequence: 3 }
const TEMPORARY: string[] = []

afterEach(async () => {
  for (const directory of TEMPORARY.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function executableFixture(): ProtectedClaudeExecutable {
  const platform =
    process.platform === 'linux'
      ? 'linux-x64'
      : process.platform === 'win32'
        ? 'win32-x64'
        : 'darwin-arm64'
  return {
    path: process.platform === 'win32' ? 'C:\\Claude\\claude.exe' : '/opt/claude/claude',
    platform,
    sha256: PROTECTED_CLAUDE_NATIVE_HASHES[platform]
  }
}

function page(items: AgentJournalRenderItem[] = []): AgentSessionHistoryPage {
  return {
    sessionId: SESSION_ID,
    epoch: 'epoch-1',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: CURSOR },
    hasOlder: false,
    hasNewer: false
  }
}

function submission(state: AgentJournalDispatchState): AgentJournalSubmission {
  return {
    clientMessageId: 'message-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: state,
    providerItemId: state === 'accepted' ? 'provider-item-1' : null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

function sendResult(state: AgentJournalDispatchState): AgentSessionSendResult {
  return { clientMessageId: 'message-1', submission: submission(state) }
}

function message(
  role: 'user' | 'assistant' | 'reasoning',
  text: string,
  sequence: number
): AgentJournalRenderItem {
  return {
    itemId: `${role}-${sequence}`,
    revision: 1,
    body: { kind: 'message', role, blocks: [{ type: 'text', text }] },
    sequence,
    observedAt: 1
  }
}

function completion(sessionId: string): AgentSessionTurnCompletion {
  return {
    scope: LOCATION,
    sessionId,
    turnId: 'turn-1',
    outcome: 'success',
    completedAt: 2
  }
}

const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'worktree-1',
  workspaceKind: 'git-worktree'
}

const ACCEPTED_CREATE: AgentSessionMutationResult<AgentSessionAttachResult> = {
  ok: true,
  replayed: false,
  fence: 1,
  cursor: CURSOR,
  value: {
    sessionId: SESSION_ID,
    fence: 1,
    page: page(),
    unconfirmedClientMessageIds: []
  }
}

function fakeHost(
  config: {
    create?: () => AgentSessionMutationResult<AgentSessionAttachResult>
    send?: (context: {
      publish: (completion: AgentSessionTurnCompletion) => void
      sessionId: string
    }) =>
      | AgentSessionMutationResult<AgentSessionSendResult>
      | Promise<AgentSessionMutationResult<AgentSessionSendResult>>
    settlement?: { cursor: AgentJournalCursor; value: AgentSessionSendResult }
    items?: AgentJournalRenderItem[]
  } = {}
) {
  const subscribers = new Map<
    string,
    Parameters<ForgeAnalysisHostPort['subscribeTurnCompletions']>[0]
  >()
  const creates: Parameters<ForgeAnalysisHostPort['create']>[] = []
  const sends: Parameters<ForgeAnalysisHostPort['send']>[] = []
  const settlements: { sessionId: string; clientMessageId: string; budgetMs?: number }[] = []
  const histories: Parameters<ForgeAnalysisHostPort['history']>[] = []

  const publish = (event: AgentSessionTurnCompletion): void => {
    for (const subscriber of subscribers.values()) {
      subscriber.emit({ type: 'completion', completion: event })
    }
  }

  const port: ForgeAnalysisHostPort = {
    create: async (caller, params, options) => {
      creates.push([caller, params, options])
      return (config.create ?? (() => ACCEPTED_CREATE))()
    },
    send: async (caller, params) => {
      sends.push([caller, params])
      const result = await (config.send?.({
        publish,
        sessionId: params.envelope.sessionId
      }) ?? {
        ok: true as const,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: sendResult('accepted')
      })
      return result
    },
    waitForSendSettlement: async (sessionId, clientMessageId, options) => {
      settlements.push({ sessionId, clientMessageId, budgetMs: options?.budgetMs })
      return config.settlement
    },
    history: async (request, scope) => {
      histories.push([request, scope])
      const result: AgentSessionHistoryResult = { ok: true, page: page(config.items) }
      return result
    },
    subscribeTurnCompletions: (subscriber) => {
      subscribers.set(subscriber.id, subscriber)
      return () => {
        subscribers.delete(subscriber.id)
      }
    }
  }

  return { port, creates, sends, settlements, histories, publish, subscribers }
}

async function makeHost(
  options: {
    host?: ReturnType<typeof fakeHost>
    deps?: Partial<ForgeInboxAnalysisHostDeps>
    env?: Record<string, string>
  } = {}
) {
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), 'forge-analysis-host-')))
  TEMPORARY.push(stateDirectory)
  const host = options.host ?? fakeHost()
  const service = createForgeInboxAnalysisHost({
    stateDirectory,
    auth: {
      getSettings: () => ({
        agentDefaultEnv: { claude: options.env ?? { ANTHROPIC_API_KEY: 'sk-test' } }
      })
    },
    scanRoots: async () => [],
    resolveWorkspacePath: async () => '/repos/worktree-1',
    ensureHost: async () => host.port,
    resolveExecutablePath: async () => EXECUTABLE.path,
    inspectExecutable: async () => EXECUTABLE,
    ...options.deps
  })
  return { service, host, stateDirectory }
}

async function prepared(service: Awaited<ReturnType<typeof makeHost>>['service']) {
  const founding = await service.prepare({
    sessionId: SESSION_ID,
    subject: SUBJECT,
    launch: LAUNCH
  })
  return {
    founding,
    open: () =>
      service.openSession({
        sessionId: SESSION_ID,
        subject: SUBJECT,
        founding,
        launchDirectory: protectedClaudePrivatePath(
          founding.protectedClaudeLaunch.privateRoot,
          'work'
        )
      })
  }
}

describe('forge inbox analysis host: prepare', () => {
  it('founds a protected session whose home, config and work all sit in the private root', async () => {
    const { service, stateDirectory } = await makeHost()
    const founding = await service.prepare({
      sessionId: SESSION_ID,
      subject: SUBJECT,
      launch: LAUNCH
    })

    const privateRoot = join(stateDirectory, 'forge-protected-analysis', SESSION_ID)
    expect(founding.protectedClaudeLaunch.privateRoot).toBe(privateRoot)
    expect(founding.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: protectedClaudePrivatePath(privateRoot, 'config')
    })
    expect(founding.options).toEqual({ model: LAUNCH.model })
    expect(founding.protectedClaudeLaunch.executable).toEqual(EXECUTABLE)
  })

  it('takes the one saved credential the settings carry and nothing else', async () => {
    const { service } = await makeHost({ env: { ANTHROPIC_AUTH_TOKEN: 'oauth-like' } })
    const founding = await service.prepare({
      sessionId: SESSION_ID,
      subject: SUBJECT,
      launch: LAUNCH
    })

    expect(founding.protectedClaudeLaunch.auth).toEqual({
      kind: 'saved-agent-env',
      settingsKey: 'claude',
      credentialKey: 'ANTHROPIC_AUTH_TOKEN',
      baseUrl: 'https://api.anthropic.com'
    })
  })

  it('refuses settings with no saved credential', async () => {
    const { service } = await makeHost({ env: {} })

    await expect(
      service.prepare({ sessionId: SESSION_ID, subject: SUBJECT, launch: LAUNCH })
    ).rejects.toThrow('forge_analysis_auth_unavailable')
  })

  it('refuses settings with two saved credentials rather than choosing one', async () => {
    const { service } = await makeHost({
      env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'oauth-like' }
    })

    await expect(
      service.prepare({ sessionId: SESSION_ID, subject: SUBJECT, launch: LAUNCH })
    ).rejects.toThrow('forge_analysis_auth_unavailable')
  })

  it('refuses an agent other than claude', async () => {
    const { service } = await makeHost()

    await expect(
      service.prepare({
        sessionId: SESSION_ID,
        subject: SUBJECT,
        launch: { ...LAUNCH, agentId: 'codex' }
      })
    ).rejects.toThrow('forge_analysis_agent_unsupported')
  })

  it('refuses a project with no workspace', async () => {
    const { service } = await makeHost()

    await expect(
      service.prepare({
        sessionId: SESSION_ID,
        subject: SUBJECT,
        launch: { ...LAUNCH, workspaceId: null }
      })
    ).rejects.toThrow('forge_analysis_workspace_unavailable')
  })

  it('refuses the floating workspace without asking for its directory', async () => {
    let resolved = 0
    const { service } = await makeHost({
      deps: {
        resolveWorkspacePath: async () => {
          resolved += 1
          return '/repos/floating'
        }
      }
    })

    await expect(
      service.prepare({
        sessionId: SESSION_ID,
        subject: SUBJECT,
        launch: { ...LAUNCH, workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
      })
    ).rejects.toThrow('forge_analysis_workspace_unavailable')
    expect(resolved).toBe(0)
  })

  it('refuses a workspace this host cannot resolve to a directory', async () => {
    const { service } = await makeHost({ deps: { resolveWorkspacePath: async () => null } })

    await expect(
      service.prepare({ sessionId: SESSION_ID, subject: SUBJECT, launch: LAUNCH })
    ).rejects.toThrow('forge_analysis_workspace_unavailable')
  })
})

describe('forge inbox analysis host: openSession', () => {
  it('creates a protected chat with no tab and the prepared location', async () => {
    const { service, host } = await makeHost()
    const { founding, open } = await prepared(service)

    const session = await open()
    expect(session).toHaveProperty('sendTurn')

    const [caller, params, options] = host.creates[0]
    expect(caller).toEqual({ callerKey: `forge-analysis:${SESSION_ID}` })
    expect(params.envelope).toMatchObject({
      sessionId: SESSION_ID,
      clientOperationId: SESSION_ID,
      expectedRuntimeFence: null
    })
    expect(params.location).toEqual(LOCATION)
    expect(params).toMatchObject({
      provider: 'claude',
      agent: 'claude',
      runtimeKind: 'native',
      accountHome: founding.accountHome,
      options: { model: LAUNCH.model }
    })
    expect(options).toEqual({
      protection: {
        protectedAnalysis: SUBJECT,
        protectedClaudeLaunch: founding.protectedClaudeLaunch
      }
    })
    expect(options).not.toHaveProperty('publishTab')
  })

  it('refuses a founding this host did not prepare', async () => {
    const preparing = await makeHost()
    const { founding } = await prepared(preparing.service)
    const { service } = await makeHost()

    await expect(
      service.openSession({
        sessionId: SESSION_ID,
        subject: SUBJECT,
        founding,
        launchDirectory: '/nowhere'
      })
    ).rejects.toThrow('forge_analysis_session_unavailable')
  })

  it('surfaces the wire refusal code when the host refuses the create', async () => {
    const refusal: AgentSessionWireRefusal = {
      code: 'structured_agent_session_unsupported',
      details: { reason: 'hostUnsupported' },
      message: 'This execution host cannot create the requested chat.'
    }
    const host = fakeHost({
      create: () => ({ ok: false, refusal })
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)

    const error = await open().catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ForgeAnalysisSessionRefusedError)
    expect(error).toHaveProperty('code', 'structured_agent_session_unsupported')
    expect(error).toHaveProperty('message', 'structured_agent_session_unsupported')
  })
})

describe('forge inbox analysis host: one turn', () => {
  it('answers with the assistant text the turn wrote after the prompt', async () => {
    const host = fakeHost({
      items: [
        message('user', 'the prompt', 1),
        message('reasoning', 'thinking', 2),
        message('assistant', 'First point.', 3),
        message('assistant', 'Second point.', 4)
      ]
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    const pending = session.sendTurn('the prompt', new AbortController().signal)
    host.publish(completion(SESSION_ID))

    await expect(pending).resolves.toBe('First point.\nSecond point.')
    expect(host.histories[0]).toEqual([
      { sessionId: SESSION_ID, direction: 'tail', limit: 200 },
      'own-agent'
    ])
    expect(host.subscribers.size).toBe(0)
  })

  it('settles on a completion that arrives before the send call returns', async () => {
    const host = fakeHost({
      items: [message('user', 'the prompt', 1), message('assistant', 'Early reply.', 2)],
      send: ({ publish, sessionId }) => {
        publish(completion(sessionId))
        return {
          ok: true,
          replayed: false,
          fence: 1,
          cursor: CURSOR,
          value: sendResult('accepted')
        }
      }
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBe(
      'Early reply.'
    )
  })

  it('ignores a completion for another session', async () => {
    const host = fakeHost({
      items: [message('user', 'the prompt', 1), message('assistant', 'Later.', 2)]
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    const pending = session.sendTurn('the prompt', new AbortController().signal)
    host.publish(completion('someone-else'))
    const first = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 0))
    ])
    expect(first).toBe('waiting')

    host.publish(completion(SESSION_ID))
    await expect(pending).resolves.toBe('Later.')
  })

  it('waits out a pending submission until the host settles it as accepted', async () => {
    const host = fakeHost({
      send: () => ({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: sendResult('pending')
      }),
      settlement: { cursor: CURSOR, value: sendResult('accepted') },
      items: [message('user', 'the prompt', 1), message('assistant', 'Settled reply.', 2)]
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    const pending = session.sendTurn('the prompt', new AbortController().signal)
    await Promise.resolve()
    host.publish(completion(SESSION_ID))

    await expect(pending).resolves.toBe('Settled reply.')
    expect(host.settlements).toHaveLength(1)
    expect(host.settlements[0]).toMatchObject({
      sessionId: SESSION_ID,
      clientMessageId: 'message-1'
    })
  })

  it('reports nothing when the send is refused', async () => {
    const host = fakeHost({ send: () => ({ ok: false, refusal: refusedSend() }) })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBeNull()
    expect(host.histories).toHaveLength(0)
    expect(host.subscribers.size).toBe(0)
  })

  it('reports nothing when the send could not be proven accepted', async () => {
    const host = fakeHost({ send: () => accepted({ ...sendResult('unknown') }) })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBeNull()
    expect(host.histories).toHaveLength(0)
  })

  it('sends nothing when the turn was already aborted', async () => {
    const host = fakeHost()
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()
    const stop = new AbortController()
    stop.abort()

    await expect(session.sendTurn('the prompt', stop.signal)).resolves.toBeNull()
    expect(host.sends).toHaveLength(0)
    expect(host.subscribers.size).toBe(0)
  })

  it('stops waiting, and unsubscribes, when the turn is aborted mid-answer', async () => {
    const host = fakeHost()
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()
    const stop = new AbortController()

    const pending = session.sendTurn('the prompt', stop.signal)
    await Promise.resolve()
    expect(host.subscribers.size).toBe(1)

    stop.abort()
    await expect(pending).resolves.toBeNull()
    expect(host.histories).toHaveLength(0)
    expect(host.subscribers.size).toBe(0)
  })

  it('reports nothing when the page holds no prompt to answer', async () => {
    const host = fakeHost({ items: [message('assistant', 'orphan', 1)] })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    const pending = session.sendTurn('the prompt', new AbortController().signal)
    host.publish(completion(SESSION_ID))
    await expect(pending).resolves.toBeNull()
  })

  it('reports nothing when the assistant said only whitespace', async () => {
    const host = fakeHost({
      items: [message('user', 'the prompt', 1), message('assistant', '   \n', 2)]
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    const pending = session.sendTurn('the prompt', new AbortController().signal)
    host.publish(completion(SESSION_ID))
    await expect(pending).resolves.toBeNull()
  })
})

function accepted(
  result: AgentSessionSendResult
): AgentSessionMutationResult<AgentSessionSendResult> {
  return { ok: true, replayed: false, fence: 1, cursor: CURSOR, value: result }
}

function refusedSend(): AgentSessionWireRefusal {
  return {
    code: 'agent_session_operation_invalid',
    details: { reason: 'requestMalformed' },
    message: 'The send request is malformed.'
  }
}
