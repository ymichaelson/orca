import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
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
    epoch: CURSOR.epoch,
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: CURSOR },
    liveCursor: {
      epoch: CURSOR.epoch,
      sequence: items.reduce((sequence, item) => Math.max(sequence, item.sequence), CURSOR.sequence)
    },
    hasOlder: false,
    hasNewer: false
  }
}

function submission(
  state: AgentJournalDispatchState,
  clientMessageId: string
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: state,
    providerItemId: state === 'accepted' ? 'provider-item-1' : null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

function sendResult(
  state: AgentJournalDispatchState,
  clientMessageId: string
): AgentSessionSendResult {
  return { clientMessageId, submission: submission(state, clientMessageId) }
}

function message(
  role: 'user' | 'assistant' | 'reasoning',
  text: string,
  sequence: number,
  turnItemId?: string
): AgentJournalRenderItem {
  return {
    itemId: `${role}-${sequence}`,
    revision: 1,
    body: { kind: 'message', role, blocks: [{ type: 'text', text }] },
    sequence,
    observedAt: 1,
    ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
  }
}

/** The rows a real host writes for one send: the turn names its submission key, the answer is
 *  scoped to that turn, and a reasoning row in the same scope is not part of the reply. */
function journalTurn(clientMessageId: string, reply: string): AgentJournalRenderItem[] {
  const turnItemId = `claude:turn:${clientMessageId}`
  return [
    {
      ...message('user', 'the prompt', 1, turnItemId),
      itemId: agentJournalSubmissionKey(clientMessageId)
    },
    {
      itemId: turnItemId,
      revision: 1,
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        userItemId: agentJournalSubmissionKey(clientMessageId),
        state: 'completed',
        outcome: 'success'
      },
      sequence: 2,
      observedAt: 1,
      turnScope: { kind: 'thread' }
    },
    message('reasoning', 'thinking', 3, turnItemId),
    message('assistant', reply, 4, turnItemId)
  ]
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
      clientMessageId: string
    }) =>
      | AgentSessionMutationResult<AgentSessionSendResult>
      | Promise<AgentSessionMutationResult<AgentSessionSendResult>>
    settlement?: (clientMessageId: string) => {
      cursor: AgentJournalCursor
      value: AgentSessionSendResult
    }
    reply?: string
    /** Off for a test that must observe the wait before any completion exists. */
    autoComplete?: boolean
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
  let items: AgentJournalRenderItem[] = []

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
      const clientMessageId = params.envelope.clientOperationId
      const result = await (config.send?.({
        publish,
        sessionId: params.envelope.sessionId,
        clientMessageId
      }) ?? {
        ok: true as const,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: sendResult('accepted', clientMessageId)
      })
      if (result.ok && 'submission' in result.value) {
        items = [...items, ...journalTurn(clientMessageId, config.reply ?? 'reply')]
        if (config.autoComplete !== false && result.value.submission.dispatchState === 'accepted') {
          queueMicrotask(() => publish(completion(params.envelope.sessionId)))
        }
      }
      return result
    },
    waitForSendSettlement: async (sessionId, clientMessageId, options) => {
      settlements.push({ sessionId, clientMessageId, budgetMs: options?.budgetMs })
      const settled = config.settlement?.(clientMessageId)
      if (
        settled &&
        'submission' in settled.value &&
        settled.value.submission.dispatchState === 'accepted' &&
        config.autoComplete !== false
      ) {
        queueMicrotask(() => publish(completion(sessionId)))
      }
      return settled
    },
    history: async (request, scope) => {
      histories.push([request, scope])
      const result: AgentSessionHistoryResult = { ok: true, page: page(items) }
      return result
    },
    currentWork: () => ({
      working: () => false,
      hasActionablePrompt: () => false,
      activeTurnId: () => null
    }),
    sessionRecord: () => ({
      lease: {
        runtimeFence: 1,
        unreconciled: false,
        handoffStage: null,
        claimStatus: 'live' as const
      }
    }),
    subscribeTurnCompletions: (subscriber) => {
      subscribers.set(subscriber.id, subscriber)
      return () => {
        subscribers.delete(subscriber.id)
      }
    }
  }

  return {
    port,
    creates,
    sends,
    settlements,
    histories,
    publish,
    subscribers,
    get items() {
      return items
    },
    set items(value: AgentJournalRenderItem[]) {
      items = value
    }
  }
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
  it('answers with the text its own turn wrote, not reasoning or another turn', async () => {
    const host = fakeHost({ reply: 'First point.\nSecond point.' })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBe(
      'First point.\nSecond point.'
    )
    expect(host.histories[0]).toEqual([
      { sessionId: SESSION_ID, direction: 'tail', limit: 1 },
      'own-agent'
    ])
    expect(host.histories[1]).toEqual([
      { sessionId: SESSION_ID, direction: 'tail', limit: 100 },
      'own-agent'
    ])
    expect(host.subscribers.size).toBe(0)
  })

  it('settles on a completion that arrives before the send call returns', async () => {
    const host = fakeHost({
      reply: 'Early reply.',
      send: ({ publish, sessionId, clientMessageId }) => {
        publish(completion(sessionId))
        return {
          ok: true,
          replayed: false,
          fence: 1,
          cursor: CURSOR,
          value: sendResult('accepted', clientMessageId)
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
    const host = fakeHost({ reply: 'Later.', autoComplete: false })
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
      reply: 'Settled reply.',
      send: ({ clientMessageId }) => ({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: sendResult('pending', clientMessageId)
      }),
      settlement: (clientMessageId) => ({
        cursor: CURSOR,
        value: sendResult('accepted', clientMessageId)
      })
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBe(
      'Settled reply.'
    )
    expect(host.settlements).toHaveLength(1)
    expect(host.settlements[0]).toMatchObject({
      sessionId: SESSION_ID,
      clientMessageId: host.sends[0]![1].envelope.clientOperationId
    })
  })

  it('reports nothing when the send is refused', async () => {
    const host = fakeHost({ send: () => ({ ok: false, refusal: refusedSend() }) })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBeNull()
    expect(host.sends).toHaveLength(1)
    expect(host.histories).toHaveLength(1)
    expect(host.subscribers.size).toBe(0)
  })

  it('reports nothing when the send could not be proven accepted', async () => {
    const host = fakeHost({
      send: ({ clientMessageId }) => accepted(sendResult('unknown', clientMessageId))
    })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBeNull()
    expect(host.histories).toHaveLength(1)
    expect(host.subscribers.size).toBe(0)
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
    const host = fakeHost({ autoComplete: false })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()
    const stop = new AbortController()

    const pending = session.sendTurn('the prompt', stop.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.subscribers.size).toBe(1)

    stop.abort()
    await expect(pending).resolves.toBeNull()
    expect(host.sends).toHaveLength(1)
    expect(host.subscribers.size).toBe(0)
  })

  it('reports nothing when no turn names this send', async () => {
    const host = fakeHost({ autoComplete: false })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()
    const stop = new AbortController()

    const pending = session.sendTurn('the prompt', stop.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.items = host.items.map((item) =>
      item.body.kind === 'turn'
        ? { ...item, body: { ...item.body, userItemId: 'another-send' } }
        : item
    )
    host.publish(completion(SESSION_ID))
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop.abort()

    await expect(pending).resolves.toBeNull()
    expect(host.subscribers.size).toBe(0)
  })

  it('reports nothing when the assistant said only whitespace', async () => {
    const host = fakeHost({ reply: '   \n' })
    const { service } = await makeHost({ host })
    const { open } = await prepared(service)
    const session = await open()

    await expect(session.sendTurn('the prompt', new AbortController().signal)).resolves.toBeNull()
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
