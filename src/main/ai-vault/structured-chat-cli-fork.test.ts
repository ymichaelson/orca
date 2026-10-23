import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  isStructuredChatCliForkSourceCurrent,
  prepareStructuredChatCliFork
} from './structured-chat-cli-fork'
import {
  PROTECTED_ANALYSIS_MARKER,
  protectedClaudeLaunchFixture
} from '../../shared/agent-session-protected-claude-launch.test-fixture'
import { isProtectedClaudeRecordBinding } from '../../shared/agent-session-protected-claude-launch'
import { foundAgentSessionRecord } from '../runtime/agent-session-record-founding'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { prepareLegacySharedCodexSessionResume } from '../codex/codex-legacy-session-resume'
import { AiVaultPrepareSessionResumeParams } from '../../shared/rpc-contract/ai-vault-params'

let root: string | undefined
const request = {
  sourceChat: { sessionId: 'session-alpha-1', workspaceId: 'workspace-1' },
  fork: true
} as const
const prepare = vi.fn(async () => ({ useRealCodexHome: false }))
function savedJournal(): AgentJournalSnapshot {
  return {
    sessionId: 'session-alpha-1',
    cursor: { epoch: 'e', sequence: 1 },
    submissions: [],
    items: [
      {
        itemId: 'legacy:pi:source:user-1',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Saved prompt' }] }
      }
    ]
  }
}
function install(record: AgentSessionRecord, copy = vi.fn(), journal = savedJournal()) {
  const journalSnapshot = vi.fn(async () => journal)
  const resolveWorkspacePath = vi.fn(async () => root)
  const resolveLaunchEnv = vi.fn(() => ({}))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preparation reads only these host dependencies.
  setStructuredAgentSessionHost({
    journalSnapshot,
    deps: {
      store: { getRecord: () => record, listRecords: () => [record] },
      adapter: { copyConversation: copy },
      resolveWorkspacePath,
      resolveLaunchEnv
    }
  } as never)
  return { journalSnapshot, resolveWorkspacePath, resolveLaunchEnv, copy }
}
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  prepare.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

async function savedClaudeRecord() {
  root = await mkdtemp(join(tmpdir(), 'chat-cli-fork-protected-'))
  const fixture = agentSessionRecordFixture()
  const launch = protectedClaudeLaunchFixture(join(root, 'private'))
  const record = foundAgentSessionRecord(
    {
      ...fixture,
      location: { ...fixture.location, workspaceKind: 'folder' },
      launchDirectory: root,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(launch.privateRoot, 'config') },
      options: { model: 'opus' },
      protectedAnalysis: PROTECTED_ANALYSIS_MARKER,
      protectedClaudeLaunch: launch
    },
    { claimKeyId: 'key-1', now: 1_000 }
  )
  record.providerHandleChain = fixture.providerHandleChain
  const directory = join(launch.privateRoot, 'config', 'projects', 'saved-workspace')
  const filePath = join(directory, 'provider-session-alpha-1.jsonl')
  await mkdir(directory, { recursive: true })
  await writeFile(filePath, '{"type":"user","message":{"role":"user","content":"Saved prompt"}}\n')
  const journal = savedJournal()
  journal.items[0]!.itemId = 'legacy:claude:source:user-1'
  return { record, filePath, journal }
}

it.each(['sealed', 'marker-only', 'launch-only'] as const)(
  'refuses a %s protected CLI fork before ordinary launch or transcript preparation',
  async (kind) => {
    const { record, journal } = await savedClaudeRecord()
    expect(isProtectedClaudeRecordBinding(record)).toBe(true)
    if (kind === 'marker-only') {
      delete record.protectedClaudeLaunch
    } else if (kind === 'launch-only') {
      delete record.protectedAnalysis
      expect(isProtectedClaudeRecordBinding(record)).toBe(false)
    }
    const reads = install(record, vi.fn(), journal)
    const importer = structuredAgentRuntimeRegistration('claude')?.transcriptImport
    if (!importer) {
      throw new Error('Missing Claude transcript importer')
    }
    const conversationStore = vi.spyOn(importer, 'conversationStore')
    const findTranscript = vi.spyOn(importer, 'findTranscript')
    await expect(prepareStructuredChatCliFork(request, prepare)).rejects.toThrow(
      'This chat has no saved conversation available on this host.'
    )
    for (const read of Object.values(reads)) {
      expect(read).not.toHaveBeenCalled()
    }
    expect(conversationStore).not.toHaveBeenCalled()
    expect(findTranscript).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  }
)

it.each(['sealed', 'marker-only', 'launch-only'] as const)(
  'does not offer a %s protected record as a current CLI fork source',
  async (kind) => {
    const { record, journal } = await savedClaudeRecord()
    if (kind === 'marker-only') {
      delete record.protectedClaudeLaunch
    } else if (kind === 'launch-only') {
      delete record.protectedAnalysis
    }
    install(record, vi.fn(), journal)
    expect(isStructuredChatCliForkSourceCurrent(record.sessionId, 'workspace-1')).toBe(false)
  }
)

it('still prepares an ordinary saved Claude conversation with a native handle', async () => {
  const { record, filePath, journal } = await savedClaudeRecord()
  delete record.protectedAnalysis
  delete record.protectedClaudeLaunch
  record.schemaVersion = 2
  const reads = install(record, vi.fn(), journal)
  expect(isStructuredChatCliForkSourceCurrent(record.sessionId, 'workspace-1')).toBe(true)
  await expect(prepareStructuredChatCliFork(request, prepare)).resolves.toMatchObject({
    cliForkSource: { agent: 'claude', sessionId: 'provider-session-alpha-1', filePath, cwd: root }
  })
  expect(reads.resolveWorkspacePath).toHaveBeenCalledOnce()
  expect(reads.resolveLaunchEnv).toHaveBeenCalledOnce()
  expect(reads.journalSnapshot).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ filePath, fork: true }))
})

it('locates the current Codex rollout in its recorded home and materializes the selected home', async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-cli-fork-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  const home = join(root, 'codex-runtime-home', 'home')
  const system = join(root, 'system')
  const record = agentSessionRecordFixture()
  record.provider = 'codex'
  record.accountHome = { variable: 'CODEX_HOME', path: home }
  record.providerHandleChain = [
    {
      ...record.providerHandleChain[0]!,
      handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'obsolete' }
    },
    {
      ...record.providerHandleChain[0]!,
      linkId: 'latest',
      handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'current-conversation' }
    }
  ]
  const relative = join('2026', '10', '15', 'rollout-2026-10-15-current-conversation.jsonl')
  const source = join(home, 'sessions', relative)
  await mkdir(join(home, 'sessions', '2026', '10', '15'), { recursive: true })
  await writeFile(source, '{"saved":true}\n')
  install(record)
  const result = await prepareStructuredChatCliFork(request, async (args) => {
    expect(args.sessionId).toBe('current-conversation')
    expect(args.filePath).toBe(source)
    const prepared = await prepareLegacySharedCodexSessionResume(args, {
      isHostSystemDefaultRealHomeSelected: () => true,
      legacyCodexHomePath: home,
      systemCodexHomePath: system
    })
    // Production uses its system home; this fixture selects the same materialized home explicitly.
    return { ...prepared, useRealCodexHome: false, substituteCodexHome: system }
  })
  expect(result.cliForkSource).toMatchObject({
    sessionId: 'current-conversation',
    codexHome: system,
    filePath: join(system, 'sessions', relative),
    cwd: root
  })
})

it('copies OpenCode directly from the selected record and preserves its typed account and copy id', async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-cli-fork-'))
  const record = agentSessionRecordFixture()
  record.provider = 'opencode'
  record.accountHome = { kind: 'opencode', locator: { kind: 'unmanaged' } }
  record.providerHandleChain = [
    {
      ...record.providerHandleChain[0]!,
      handle: { agent: 'opencode', transport: 'acp', nativeId: 'ses_source' }
    }
  ]
  const copy = vi.fn(async () => ({ sessionId: 'ses_copy' }))
  install(record, copy)
  const result = await prepareStructuredChatCliFork(request, prepare)
  expect(copy).toHaveBeenCalledWith(
    expect.objectContaining({
      accountHome: record.accountHome,
      providerSessionId: 'ses_source',
      identity: expect.objectContaining({ sessionId: record.sessionId })
    })
  )
  expect(result.cliForkSource).toMatchObject({
    agent: 'opencode',
    sourceAgent: 'opencode2',
    sessionId: 'ses_copy'
  })
  expect(prepare).not.toHaveBeenCalled()
})

it('uses the Pi file handle and refuses a mismatched saved header or missing handle', async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-cli-fork-'))
  const filePath = join(root, '2026-10-15_12345678-abcd-1234-abcd-123456789abc.jsonl')
  const record = agentSessionRecordFixture()
  record.provider = 'pi'
  record.providerHandleChain = [
    {
      ...record.providerHandleChain[0]!,
      handle: { agent: 'pi', transport: 'jsonl-rpc', nativeId: filePath }
    }
  ]
  await writeFile(
    filePath,
    `${JSON.stringify({ type: 'session', id: '12345678-abcd-1234-abcd-123456789abc', cwd: root })}\n`
  )
  const journal = savedJournal()
  const savedMessage = journal.items.splice(0)
  install(record, vi.fn(), journal)
  await expect(prepareStructuredChatCliFork(request, prepare)).rejects.toThrow(
    'no saved conversation'
  )
  expect(prepare).not.toHaveBeenCalled()
  await writeFile(
    filePath,
    `${JSON.stringify({ type: 'session', id: '12345678-abcd-1234-abcd-123456789abc', cwd: root })}\n${JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Saved prompt' }], timestamp: 1 } })}\n`
  )
  journal.items.push(...savedMessage)
  await expect(prepareStructuredChatCliFork(request, prepare)).resolves.toMatchObject({
    cliForkSource: { filePath, sessionId: '12345678-abcd-1234-abcd-123456789abc' }
  })
  journal.items[0]!.itemId = agentJournalSubmissionKey('send-1')
  for (const dispatchState of ['pending', 'rejected', 'unknown', 'accepted'] as const) {
    journal.submissions = [
      {
        clientMessageId: 'send-1',
        fence: 1,
        payloadFingerprint: 'p',
        dispatchState,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true
      }
    ]
    const preparation = prepareStructuredChatCliFork(request, prepare)
    await (dispatchState === 'accepted'
      ? expect(preparation).resolves.toHaveProperty('cliForkSource')
      : expect(preparation).rejects.toThrow(
          dispatchState === 'unknown' ? 'Could not confirm' : 'no saved conversation'
        ))
  }
  await writeFile(filePath, `${JSON.stringify({ type: 'session', id: 'wrong', cwd: root })}\n`)
  await expect(prepareStructuredChatCliFork(request, prepare)).rejects.toThrow('does not match')
  record.providerHandleChain = []
  await expect(prepareStructuredChatCliFork(request, prepare)).rejects.toThrow(
    'no saved conversation'
  )
})

it('refuses a foreign workspace or WSL record and rejects mixed chat/row requests', async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-cli-fork-'))
  const record = agentSessionRecordFixture()
  install(record)
  await expect(
    prepareStructuredChatCliFork(
      { ...request, sourceChat: { ...request.sourceChat, workspaceId: 'other' } },
      prepare
    )
  ).rejects.toThrow('on this host')
  record.location.wslDistro = 'Ubuntu'
  await expect(prepareStructuredChatCliFork(request, prepare)).rejects.toThrow('on this host')
  expect(
    AiVaultPrepareSessionResumeParams.safeParse({
      ...request,
      agent: 'claude',
      filePath: '/foreign'
    }).success
  ).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
})
