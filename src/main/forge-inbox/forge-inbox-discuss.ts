import {
  agentSessionProtectedAnalysisEqual,
  type AgentSessionProtectedAnalysis
} from '../../shared/agent-session-protected-analysis'
import { isProtectedClaudeRecordBinding } from '../../shared/agent-session-protected-claude-launch'
import type { ForgeDiscussRefusal } from '../../shared/forge-inbox-rpc-types'
import type { ForgeInstanceScope, ForgeRunState } from '../../shared/forge-inbox-types'
import {
  buildForgeDiscussPrompt,
  FORGE_DISCUSS_MAX_MESSAGE_CHARS
} from './forge-inbox-discuss-prompt'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  sendForgeProtectedSessionTurn,
  type ForgeProtectedSessionTurnHost
} from './forge-inbox-protected-session-turn'

export type ForgeDiscussHostPort = ForgeProtectedSessionTurnHost

/** What a discuss turn reads of a session record: which item it was founded for, and its fence. */
export type ForgeDiscussSessionRecord = {
  protectedAnalysis?: AgentSessionProtectedAnalysis
  protectedClaudeLaunch?: unknown
  provider?: unknown
  schemaVersion?: unknown
  accountHome?: unknown
  options?: unknown
  permissionMode?: unknown
  launchArgs?: unknown
  lease: { runtimeFence: number }
}

export type { ForgeDiscussRefusal }

/** `unknown` means the turn was handed over but its answer could not be proven; never a blank reply. */
export type ForgeDiscussResult =
  | { kind: 'reply'; sessionId: string; text: string }
  | { kind: 'unknown'; sessionId: string }
  | { kind: 'refused'; reason: ForgeDiscussRefusal }

export type ForgeDiscussRequest = {
  scope: ForgeInstanceScope
  runId: number
  message: string
}

export type ForgeInboxDiscuss = (
  request: ForgeDiscussRequest,
  signal: AbortSignal
) => Promise<ForgeDiscussResult>

/**
 * Continues the very session a run analysed in — never a fresh one — and only while that session's
 * record still proves it was founded for this owner, instance, item and kind. A session that is
 * not provably that one is refused rather than resumed as an ordinary chat.
 */
export function createForgeInboxDiscuss(deps: {
  ledger: Pick<ForgeInboxLedger, 'getRun' | 'getItem' | 'getConfig'>
  ensureHost: () => Promise<ForgeDiscussHostPort>
  /** May install the chat host first: a profile that never opened a chat still has its records. */
  readRecord: (
    sessionId: string
  ) => ForgeDiscussSessionRecord | null | Promise<ForgeDiscussSessionRecord | null>
}): ForgeInboxDiscuss {
  const { ledger } = deps
  return async ({ scope, runId, message }, signal) => {
    const trimmed = message.trim()
    if (trimmed === '') {
      return { kind: 'refused', reason: 'message-empty' }
    }
    if (message.length > FORGE_DISCUSS_MAX_MESSAGE_CHARS) {
      return { kind: 'refused', reason: 'message-too-large' }
    }
    const run = ledger.getRun(runId)
    if (!run) {
      return { kind: 'refused', reason: 'run-missing' }
    }
    // Scoped lookup: another instance's run is not addressable here.
    const item = ledger.getItem(scope, run.itemId)
    if (!item) {
      return { kind: 'refused', reason: 'run-missing' }
    }
    if (!run.sessionId || !DISCUSSABLE_RUN_STATES.has(run.state)) {
      return { kind: 'refused', reason: 'run-not-analysed' }
    }
    const project = ledger
      .getConfig()
      .config.instances.find((instance) => instance.id === item.instanceId)
      ?.projects.find((candidate) => candidate.projectId === item.projectId)
    if (!project || !project.enabled) {
      return { kind: 'refused', reason: 'project-unavailable' }
    }
    const subject: AgentSessionProtectedAnalysis = {
      ownerId: item.hostId,
      instanceId: item.instanceId,
      itemId: String(item.id),
      analysisKind: item.kind
    }
    const sessionId = run.sessionId
    const record = await deps.readRecord(sessionId)
    if (!record) {
      return { kind: 'refused', reason: 'session-missing' }
    }
    // The ledger names the session; the record must independently prove it is this item's.
    if (
      !isProtectedClaudeRecordBinding(record) ||
      !agentSessionProtectedAnalysisEqual(record.protectedAnalysis, subject)
    ) {
      return { kind: 'refused', reason: 'session-not-protected' }
    }
    if (signal.aborted) {
      return { kind: 'unknown', sessionId }
    }
    const host = await deps.ensureHost()
    const prompt = buildForgeDiscussPrompt({ subject, revision: run.revision, message: trimmed })
    const outcome = await sendForgeProtectedSessionTurn({
      host,
      callerKey: `forge-discuss:${sessionId}`,
      sessionId,
      fence: record.lease.runtimeFence,
      prompt,
      signal
    })
    if (outcome.kind === 'refused') {
      return { kind: 'refused', reason: 'send-refused' }
    }
    return outcome.kind === 'reply'
      ? { kind: 'reply', sessionId, text: outcome.text }
      : { kind: 'unknown', sessionId }
  }
}

/** A run in these states has an analysis to discuss; a live one belongs to the analysis turn. */
const DISCUSSABLE_RUN_STATES: ReadonlySet<ForgeRunState> = new Set([
  'succeeded',
  'awaiting-approval'
])
