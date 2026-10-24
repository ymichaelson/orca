import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { PROTECTED_CLAUDE_NATIVE_HASHES } from '../../shared/agent-session-protected-claude-launch'
import type {
  AgentSessionHistoryPage,
  AgentSessionSendResult
} from '../../shared/agent-session-wire'
import type {
  AgentJournalCursor,
  AgentJournalDispatchState,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ProtectedClaudeExecutable } from '../claude/claude-protected-native-profile'
import type { ForgeAnalysisHostPort } from './forge-inbox-analysis-host'
import { createForgeInboxRuntimeAnalysis } from './forge-inbox-analysis-runtime'
import { mergeRequestHookBody, SHA_A } from './forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'

const WORKSPACE_ID = 'folder:review-folder'
const MODEL = 'claude-protected-analysis'
const RESULT = {
  summary: 'The change needs a regression test.',
  concerns: ['The new branch has no coverage.'],
  draft: 'Please add the regression test.\n\nKeep this exact spacing.  '
}
const CURSOR: AgentJournalCursor = { epoch: 'analysis-epoch', sequence: 2 }

function runs(fx: OwnerFixture) {
  return fx.rows('SELECT state, error, session_id, result_json FROM runs ORDER BY id')
}

function page(
  sessionId: string,
  items: AgentSessionHistoryPage['items'] = []
): AgentSessionHistoryPage {
  return {
    sessionId,
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
  clientMessageId: string,
  dispatchState: AgentJournalDispatchState
): AgentSessionSendResult {
  return {
    clientMessageId,
    submission: {
      clientMessageId,
      fence: 1,
      payloadFingerprint: 'synthetic-host-submission',
      dispatchState,
      providerItemId: dispatchState === 'accepted' ? 'provider-item-1' : null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }
  }
}

/** The exact rows one send writes; only a reply turn completes and carries assistant text. */
function sentJournal(
  send: Parameters<ForgeAnalysisHostPort['send']>,
  outcome: 'reply' | 'held' | 'unknown'
): AgentJournalRenderItem[] {
  const turnItemId = 'claude:turn-1'
  return [
    {
      itemId: agentJournalSubmissionKey(send[1].envelope.clientOperationId),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: send[1].body,
      turnScope: { kind: 'turn', turnItemId }
    },
    {
      itemId: turnItemId,
      revision: 1,
      sequence: 2,
      observedAt: 1,
      turnScope: { kind: 'thread' },
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        userItemId: agentJournalSubmissionKey(send[1].envelope.clientOperationId),
        state: outcome === 'reply' ? 'completed' : 'running',
        ...(outcome === 'reply' ? { outcome: 'success' as const } : {})
      }
    },
    ...(outcome === 'reply'
      ? [
          {
            itemId: 'reply',
            revision: 1,
            sequence: 3,
            observedAt: 2,
            turnScope: { kind: 'turn' as const, turnItemId },
            body: {
              kind: 'message' as const,
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, text: JSON.stringify(RESULT) }]
            }
          }
        ]
      : [])
  ]
}

function fakeHost(fx: OwnerFixture, outcome: 'reply' | 'held' | 'unknown') {
  const creates: Parameters<ForgeAnalysisHostPort['create']>[] = []
  const sends: Parameters<ForgeAnalysisHostPort['send']>[] = []
  const bindings: { stage: string; sessionId: string; rows: ReturnType<typeof runs> }[] = []
  const subscribers = new Map<
    string,
    Parameters<ForgeAnalysisHostPort['subscribeTurnCompletions']>[0]
  >()
  let markSent: () => void = () => undefined
  const sent = new Promise<void>((resolve) => (markSent = resolve))
  let settlements = 0
  let histories = 0
  const host: ForgeAnalysisHostPort = {
    create: async (...args) => {
      creates.push(args)
      const sessionId = args[1].envelope.sessionId
      bindings.push({ stage: 'create', sessionId, rows: runs(fx) })
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: { sessionId, fence: 1, page: page(sessionId), unconfirmedClientMessageIds: [] }
      }
    },
    send: async (...args) => {
      sends.push(args)
      const sessionId = args[1].envelope.sessionId
      const clientMessageId = args[1].envelope.clientOperationId
      bindings.push({ stage: 'send', sessionId, rows: runs(fx) })
      if (outcome === 'reply') {
        for (const subscriber of subscribers.values()) {
          subscriber.emit({
            type: 'completion',
            completion: {
              scope: creates[0][1].location,
              sessionId,
              turnId: 'turn-1',
              outcome: 'success',
              completedAt: 2
            }
          })
        }
      }
      markSent()
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: CURSOR,
        value: submission(
          clientMessageId,
          outcome === 'reply' ? 'pending' : outcome === 'held' ? 'accepted' : 'unknown'
        )
      }
    },
    waitForSendSettlement: async (_sessionId, clientMessageId) => {
      settlements += 1
      return { cursor: CURSOR, value: submission(clientMessageId, 'accepted') }
    },
    history: async (request) => {
      histories += 1
      return {
        ok: true,
        page: page(request.sessionId, sends[0] ? sentJournal(sends[0], outcome) : [])
      }
    },
    subscribeTurnCompletions: (subscriber) => {
      subscribers.set(subscriber.id, subscriber)
      return () => {
        subscribers.delete(subscriber.id)
      }
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
    })
  }
  return {
    host,
    creates,
    sends,
    bindings,
    subscribers,
    sent,
    settlements: () => settlements,
    histories: () => histories
  }
}

async function runtimeAnalysis(fx: OwnerFixture, host: ForgeAnalysisHostPort) {
  const stateDirectory = await realpath(fx.root)
  const workspacePath = join(stateDirectory, 'review-folder')
  await mkdir(workspacePath)
  const platform =
    process.platform === 'linux'
      ? 'linux-x64'
      : process.platform === 'win32'
        ? 'win32-x64'
        : 'darwin-arm64'
  const executable: ProtectedClaudeExecutable = {
    path: join(stateDirectory, process.platform === 'win32' ? 'claude.exe' : 'claude'),
    platform,
    sha256: PROTECTED_CLAUDE_NATIVE_HASHES[platform]
  }
  return createForgeInboxRuntimeAnalysis({
    runtime: {
      stateDirectory,
      getSettings: () => ({ agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'sk-test' } } }),
      scanRoots: () => [],
      resolveWorkspacePath: async (workspaceId) =>
        workspaceId === WORKSPACE_ID ? workspacePath : null,
      ensureHost: async () => host,
      resolveExecutablePath: async () => executable.path,
      inspectExecutable: async () => executable
    },
    http: fx.gate.http
  })
}

async function startAnalysis(fx: OwnerFixture, outcome: 'reply' | 'held' | 'unknown') {
  const host = fakeHost(fx, outcome)
  const analyse = await runtimeAnalysis(fx, host.host)
  const service = fx.service({ analyse })
  const port = await freePort()
  await service.start()
  await provision(service, listenerOn(port), {
    project: { automaticAnalysis: true, agentId: 'claude', model: MODEL, workspaceId: WORKSPACE_ID }
  })
  const hook = mergeRequestHookBody({ reviewers: ['me'] })
  expect(await postHook(port, hook, 'analysis-1')).toMatchObject({ status: 202 })
  return { host, analyse, service, port, hook }
}

function expectBoundBeforeHost(host: ReturnType<typeof fakeHost>) {
  expect(host.creates).toHaveLength(1)
  const sessionId = host.creates[0][1].envelope.sessionId
  expect(host.bindings).toEqual(
    ['create', 'send'].map((stage) => ({
      stage,
      sessionId,
      rows: [{ state: 'running', error: null, session_id: sessionId, result_json: null }]
    }))
  )
  return sessionId
}

describe('forge inbox owner with production runtime analysis', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('binds before opening, settles the protected turn and stores one exact pending comment without publishing', async () => {
    fx = createOwnerFixture()
    const { host, service, port, hook } = await startAnalysis(fx, 'reply')
    await service.settled()

    const sessionId = expectBoundBeforeHost(host)
    expect(runs(fx)).toEqual([
      {
        state: 'succeeded',
        error: null,
        session_id: sessionId,
        result_json: JSON.stringify(RESULT)
      }
    ])
    expect(host.creates[0][1]).toMatchObject({
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: WORKSPACE_ID,
        workspaceKind: 'folder'
      },
      provider: 'claude',
      runtimeKind: 'native',
      options: { model: MODEL }
    })
    expect(host.creates[0][2]).toMatchObject({
      protection: {
        protectedAnalysis: { instanceId: INSTANCE_ID, itemId: '1', analysisKind: 'merge_request' }
      }
    })
    expect(host.settlements()).toBe(1)
    expect(host.histories()).toBe(2)
    expect(host.subscribers.size).toBe(0)
    expect(
      fx.rows(`SELECT p.status, r.session_id,
      json_extract(p.body_json, '$.kind') AS kind,
      json_extract(p.body_json, '$.target.instanceId') AS instance_id,
      json_extract(p.body_json, '$.target.projectId') AS project_id,
      json_extract(p.body_json, '$.target.kind') AS target_kind,
      json_extract(p.body_json, '$.target.iid') AS iid,
      json_extract(p.body_json, '$.headSha') AS head_sha,
      json_extract(p.body_json, '$.body') AS body
      FROM proposals p JOIN runs r ON r.id = p.run_id`)
    ).toEqual([
      {
        status: 'pending',
        session_id: sessionId,
        kind: 'comment',
        instance_id: INSTANCE_ID,
        project_id: PROJECT_ID,
        target_kind: 'merge_request',
        iid: 7,
        head_sha: SHA_A,
        body: RESULT.draft
      }
    ])
    expect(fx.gitlab.requests).toContain('/merge_requests/7/diffs')
    expect(fx.gitlab.writes).toEqual([])

    expect(await postHook(port, hook, 'analysis-1')).toMatchObject({ status: 202 })
    await service.settled()
    expect(fx.deliveries()).toHaveLength(1)
    expect(runs(fx)).toHaveLength(1)
    expect(fx.rows('SELECT id FROM proposals')).toHaveLength(1)
    expect(host.creates).toHaveLength(1)
    expect(host.sends).toHaveLength(1)
    expect(fx.gitlab.writes).toEqual([])
  })

  it.each(['held', 'unknown'] as const)(
    'does not replay a %s turn after stop and owner reopen',
    async (outcome) => {
      fx = createOwnerFixture()
      const { host, analyse, service, port, hook } = await startAnalysis(fx, outcome)
      await host.sent
      if (outcome === 'held') {
        expect(service.idle()).toBe(false)
        expect(host.subscribers.size).toBe(1)
        await service.stop()
      } else {
        await service.settled()
        await service.stop()
      }

      const sessionId = expectBoundBeforeHost(host)
      const expected = [
        {
          state: outcome === 'held' ? 'cancelled' : 'unverifiable',
          error: outcome === 'held' ? 'owner-stopped' : 'unknown-outcome',
          session_id: sessionId,
          result_json: null
        }
      ]
      expect(runs(fx)).toEqual(expected)
      expect(host.subscribers.size).toBe(0)
      expect(host.histories()).toBe(1)
      expect(fx.rows('SELECT id FROM proposals')).toEqual([])

      const reopened = fx.service({ analyse })
      await reopened.start()
      await reopened.settled()
      expect(await postHook(port, hook, 'analysis-1')).toMatchObject({ status: 202 })
      await reopened.settled()

      expect(runs(fx)).toEqual(expected)
      expect(fx.deliveries()).toHaveLength(1)
      expect(host.creates).toHaveLength(1)
      expect(host.sends).toHaveLength(1)
      expect(fx.rows('SELECT id FROM proposals')).toEqual([])
      expect(fx.gitlab.writes).toEqual([])
    }
  )
})
