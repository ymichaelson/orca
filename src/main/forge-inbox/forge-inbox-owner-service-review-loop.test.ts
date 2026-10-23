import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTECTED_CLAUDE_NATIVE_HASHES,
  PROTECTED_CLAUDE_PROFILE,
  protectedClaudePrivatePath
} from '../../shared/agent-session-protected-claude-launch'
import type {
  AgentJournalCursor,
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSendResult,
  AgentSessionTurnCompletion
} from '../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  forgeCommentMarker,
  hashForgeCommentDraft,
  parseForgeCommentDraft
} from './forge-inbox-comment-draft'
import {
  createForgeInboxDiscuss,
  type ForgeDiscussHostPort,
  type ForgeDiscussSessionRecord
} from './forge-inbox-discuss'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
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

const ANALYSIS_PROJECT = { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }
const DRAFT = 'Please add a test for the retry path.'
const SCOPE = { instanceId: INSTANCE_ID }
const OWNER_CLIENT = 'owner-1'
const SESSION = 'session-1'

type OwnerService = ReturnType<OwnerFixture['service']>

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
  role: 'user' | 'assistant',
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

function historyPage(items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  const cursor: AgentJournalCursor = { epoch: 'epoch-1', sequence: 3 }
  return {
    sessionId: SESSION,
    epoch: 'epoch-1',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    hasOlder: false,
    hasNewer: false
  }
}

function discussHost() {
  const subscribers = new Map<
    string,
    Parameters<ForgeDiscussHostPort['subscribeTurnCompletions']>[0]
  >()
  const sends: Parameters<ForgeDiscussHostPort['send']>[] = []
  const publish = (completion: AgentSessionTurnCompletion): void => {
    for (const subscriber of subscribers.values()) {
      subscriber.emit({ type: 'completion', completion })
    }
  }
  const port: ForgeDiscussHostPort = {
    send: async (caller, params) => {
      sends.push([caller, params])
      queueMicrotask(() =>
        publish({
          scope: {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            wslDistro: null,
            workspaceId: 'ws-1',
            workspaceKind: 'git-worktree'
          },
          sessionId: params.envelope.sessionId,
          turnId: 'turn-1',
          outcome: 'success',
          completedAt: 2
        })
      )
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 3 },
        value: sendResult('accepted')
      }
    },
    waitForSendSettlement: async () => undefined,
    history: async () => {
      const result: AgentSessionHistoryResult = {
        ok: true,
        page: historyPage([
          message('user', 'Is the retry path covered?', 1),
          message('assistant', 'Not yet — I flagged it.', 2)
        ])
      }
      return result
    },
    subscribeTurnCompletions: (subscriber) => {
      subscribers.set(subscriber.id, subscriber)
      return () => {
        subscribers.delete(subscriber.id)
      }
    }
  }
  return { port, sends }
}

describe('forge inbox review loop', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  async function runningService(host: ReturnType<typeof discussHost>) {
    fx = createOwnerFixture()
    const port = await freePort()
    let service!: OwnerService
    const discuss = (ledger: ForgeInboxLedger) =>
      createForgeInboxDiscuss({
        ledger,
        ensureHost: async () => host.port,
        // The record proves the session was founded for this item, not merely that an id matches.
        readRecord: () => protectedRecord(service)
      })
    service = fx.service({
      analyse:
        () =>
        async ({ bindSession }) => {
          bindSession(SESSION)
          return {
            kind: 'analysed',
            result: { summary: 'Looks fine.', concerns: ['no test'], draft: DRAFT },
            commentDraft: { headSha: SHA_A }
          }
        },
      discuss
    })
    await service.start()
    await provision(service, listenerOn(port), { project: ANALYSIS_PROJECT })
    const stored = await service.setCredential({
      instanceId: INSTANCE_ID,
      kind: 'api-write',
      secret: 'glpat-owner-write',
      expectedRevision: service.getConfig().configRevision
    })
    if (!stored.ok) {
      throw new Error(`credential rejected: ${stored.reason}`)
    }
    return { service, port }
  }

  function protectedRecord(service: OwnerService): ForgeDiscussSessionRecord {
    const item = service.listItems({ ...SCOPE, clientId: OWNER_CLIENT }).rows[0]
    if (!item) {
      throw new Error('expected one inbox item')
    }
    const privateRoot = `/state/forge-protected-analysis/${SESSION}`
    return {
      schemaVersion: 3,
      provider: 'claude',
      accountHome: {
        variable: 'CLAUDE_CONFIG_DIR',
        path: protectedClaudePrivatePath(privateRoot, 'config')
      },
      options: { model: 'claude-test' },
      protectedAnalysis: {
        ownerId: service.ownerHostId(),
        instanceId: INSTANCE_ID,
        itemId: String(item.id),
        analysisKind: 'merge_request'
      },
      protectedClaudeLaunch: {
        version: 1,
        profile: PROTECTED_CLAUDE_PROFILE,
        executable: {
          path: '/opt/claude/claude',
          platform: 'darwin-arm64',
          sha256: PROTECTED_CLAUDE_NATIVE_HASHES['darwin-arm64']
        },
        privateRoot,
        auth: {
          kind: 'saved-agent-env',
          settingsKey: 'claude',
          credentialKey: 'ANTHROPIC_API_KEY',
          baseUrl: 'https://api.anthropic.com'
        }
      },
      lease: { runtimeFence: 7 }
    }
  }

  function pendingApproval(service: OwnerService) {
    const detail = service.getItemDetail(
      SCOPE,
      service.listItems({ ...SCOPE, clientId: OWNER_CLIENT }).rows[0]!.id,
      OWNER_CLIENT
    )
    const proposal = detail?.proposals[0]
    if (!proposal || proposal.status !== 'pending') {
      throw new Error('expected one pending proposal')
    }
    const [row] = fx.rows('SELECT body_json FROM proposals WHERE id = ?', proposal.id)
    const draft = parseForgeCommentDraft(JSON.parse(String(row?.body_json)))
    if (!draft) {
      throw new Error('stored proposal is not a comment draft')
    }
    return {
      scope: SCOPE,
      proposalId: proposal.id,
      expectedHash: hashForgeCommentDraft(draft),
      expectedRevision: proposal.revision,
      expectedPolicyGeneration: proposal.policyGeneration
    }
  }

  it('carries one review request through inbox, discuss, approval and the timeline', async () => {
    const host = discussHost()
    const { service, port } = await runningService(host)

    expect((await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')).status).toBe(
      202
    )
    await service.settled()
    // A retried delivery is acknowledged again but never buys a second analysis.
    expect((await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')).status).toBe(
      202
    )
    await service.settled()

    const list = service.listItems({ ...SCOPE, clientId: OWNER_CLIENT })
    expect(list.rows).toHaveLength(1)
    const item = list.rows[0]!
    expect(item).toMatchObject({ kind: 'merge_request', iid: 7, unread: true })
    expect(fx.deliveries()).toHaveLength(1)

    const detail = service.getItemDetail(SCOPE, item.id, OWNER_CLIENT)
    expect(detail?.runs).toHaveLength(1)
    const run = detail!.runs[0]!
    expect(run).toMatchObject({
      state: 'succeeded',
      sessionId: SESSION,
      result: { summary: 'Looks fine.', concerns: ['no test'], draft: DRAFT }
    })
    expect(detail?.proposals).toHaveLength(1)
    expect(detail?.proposals[0]).toMatchObject({ status: 'pending', runId: run.id })
    // The RPC projection never carries the generated comment text.
    expect(JSON.stringify(detail?.proposals)).not.toContain(DRAFT)

    const discussed = await service.discuss(
      { scope: SCOPE, runId: run.id, message: 'Is the retry path covered?' },
      new AbortController().signal
    )
    expect(discussed).toEqual({
      kind: 'reply',
      sessionId: SESSION,
      text: 'Not yet — I flagged it.'
    })
    expect(host.sends).toHaveLength(1)
    expect(host.sends[0]?.[1].envelope).toMatchObject({
      sessionId: SESSION,
      expectedRuntimeFence: 7
    })

    const approval = pendingApproval(service)
    const approved = await service.approveComment(approval, new AbortController().signal)

    expect(approved).toMatchObject({ ok: true })
    expect(fx.gitlab.writes).toHaveLength(1)
    expect(fx.gitlab.writes[0]?.path).toBe('/merge_requests/7/notes')
    expect(JSON.parse(fx.gitlab.writes[0]?.body ?? '{}')).toEqual({
      body: `${DRAFT}\n\n${forgeCommentMarker(approval.proposalId, approval.expectedHash)}`
    })
    expect(fx.rows('SELECT state FROM receipts')).toEqual([{ state: 'applied' }])

    const after = service.getItemDetail(SCOPE, item.id, OWNER_CLIENT)
    expect(after?.proposals[0]?.status).toBe('consumed')
    expect(after?.runs[0]?.state).toBe('succeeded')

    const timeline = service
      .listEvents(SCOPE, { itemId: item.id })
      .rows.map((event) => event.eventKind)
    expect(timeline).toEqual(['gitlab.merge_request'])

    expect(service.markRead(SCOPE, { clientId: OWNER_CLIENT, itemId: item.id })).toBe(true)
    expect(service.listItems({ ...SCOPE, clientId: OWNER_CLIENT }).rows[0]?.unread).toBe(false)
    // Reading is not progress: the run stays succeeded and needs no re-analysis.
    expect(service.listRuns(SCOPE, { itemId: item.id }).rows).toHaveLength(1)
  })

  async function analysedReview(host = discussHost()) {
    const running = await runningService(host)
    await postHook(running.port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await running.service.settled()
    return running
  }

  it('invalidates a pending approval when the project rules change, keeping the analysis', async () => {
    const { service } = await analysedReview()
    const approval = pendingApproval(service)

    const updated = await service.updateProjectPolicy(service.getConfig().configRevision, {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      patch: { rules: 'Comments now need a second reviewer.' }
    })
    expect(updated.ok).toBe(true)

    const refused = await service.approveComment(approval, new AbortController().signal)
    expect(refused).toEqual({ ok: false, reason: 'stale' })
    expect(fx.gitlab.writes).toEqual([])
    expect(fx.rows('SELECT status FROM proposals')).toEqual([{ status: 'stale' }])
    // The analysis is still there to read; only its approval was revoked.
    const detail = service.getItemDetail(
      SCOPE,
      service.listItems({ ...SCOPE, clientId: OWNER_CLIENT }).rows[0]!.id,
      OWNER_CLIENT
    )
    expect(detail?.runs[0]).toMatchObject({ state: 'succeeded' })
  })

  it('reconciles a comment whose response was lost instead of posting it twice', async () => {
    const { service } = await analysedReview()
    const approval = pendingApproval(service)
    const marker = forgeCommentMarker(approval.proposalId, approval.expectedHash)
    let answered = false
    // The note lands, then the response is lost: the write happened but the caller cannot know.
    fx.gitlab.state.override = (path) => {
      if (path !== '/merge_requests/7/notes' || answered) {
        return null
      }
      answered = true
      fx.gitlab.state.notes.push({
        id: 9001,
        body: `Please add a test.\n\n${marker}`,
        author: 'me'
      })
      return new Response('{"message":"gateway timeout"}', { status: 504 })
    }

    const approved = await service.approveComment(approval, new AbortController().signal)

    expect(approved).toMatchObject({ ok: true, noteId: 9001 })
    expect(fx.gitlab.writes).toEqual([])
    expect(fx.gitlab.state.notes).toHaveLength(1)
    expect(fx.rows('SELECT state FROM receipts')).toEqual([{ state: 'applied' }])
    await expect(service.approveComment(approval, new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'not-pending'
    })
    expect(fx.gitlab.state.notes).toHaveLength(1)
  })
})
