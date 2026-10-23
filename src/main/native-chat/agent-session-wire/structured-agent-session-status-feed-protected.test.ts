// A status summary fans out to every reader — session lists, worktree.ps, mobile attention, and
// the hook store — none of which can draw protected content inertly. Its prompt, tool line and
// reply are that content, so a protected analysis publishes the state and none of the text.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { PROTECTED_ANALYSIS_MARKER } from '../../../shared/agent-session-protected-claude-launch.test-fixture'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { indexedStatusFeedSession as indexed } from './structured-agent-session-status-feed-test-session'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const SESSION = 'status-session'
const TURN = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const
const USER = { ...TURN, ordinal: 1 } as const
// The record's lease holds the live generation, so items written under an older fence read as
// work no live runtime produced.
const GEN_FENCE = agentSessionLeaseFixture().runtimeFence
const PROTECTED: Partial<AgentSessionRecord> = {
  schemaVersion: 3,
  protectedAnalysis: PROTECTED_ANALYSIS_MARKER
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-status-protected-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

type Journal = Awaited<ReturnType<typeof openJournal>>

function openJournal() {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(root, SESSION)
  })
}

/** A turn still running: the prompt, the running marker, and the tool it is inside. */
async function appendRunningTurn(journal: Journal): Promise<void> {
  await journal.appendItem(
    TURN,
    { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
    { fence: GEN_FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    USER,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'the merge request title' }] },
    { fence: GEN_FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { ...USER, ordinal: 2 },
    { kind: 'tool-call', name: 'Read', input: { file_path: '/repo/a.ts' }, state: 'running' },
    { fence: GEN_FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The reply that ends the turn, after which the running marker is tombstoned. */
async function appendReply(journal: Journal): Promise<void> {
  await journal.appendItem(
    { ...USER, ordinal: 3 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'the review reply' }] },
    { fence: GEN_FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendTombstone(TURN, { fence: GEN_FENCE })
}

function publishedSnapshot(
  record: Partial<AgentSessionRecord> | null,
  journal: Journal
): AgentSessionStatusSummary {
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[SESSION, indexed({ journal })]]),
    getRecord: () => (record ? { ...agentSessionRecordFixture(), ...record } : null),
    now: () => 1_000
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  const snapshot = events[0]
  if (snapshot?.type !== 'snapshot') {
    throw new Error('the feed opened without a snapshot')
  }
  return snapshot.sessions[0]!
}

describe('a protected analysis in the status feed', () => {
  it('publishes a running turn without its prompt or tool line', async () => {
    const journal = await openJournal()
    await appendRunningTurn(journal)

    const protectedSummary = publishedSnapshot(PROTECTED, journal)
    const ordinarySummary = publishedSnapshot(null, journal)

    expect(protectedSummary).toMatchObject({
      status: 'working',
      latestPrompt: '',
      // A reader that draws the chat needs to know it must do so inertly.
      protectedAnalysis: true
    })
    expect(protectedSummary).not.toHaveProperty('toolName')
    expect(protectedSummary).not.toHaveProperty('toolInput')
    expect(ordinarySummary).not.toHaveProperty('protectedAnalysis')
    expect(ordinarySummary).toMatchObject({
      status: 'working',
      latestPrompt: 'the merge request title',
      toolName: 'Read'
    })
  })

  it('publishes an ended turn without its reply', async () => {
    const journal = await openJournal()
    await appendRunningTurn(journal)
    await appendReply(journal)

    const protectedSummary = publishedSnapshot(PROTECTED, journal)

    expect(protectedSummary).toMatchObject({ status: 'idle', latestPrompt: '' })
    expect(protectedSummary).not.toHaveProperty('lastAssistantMessage')
    expect(publishedSnapshot(null, journal)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'the review reply'
    })
  })
})
