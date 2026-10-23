import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import type {
  ForgeAnalysisResult,
  ForgeInstanceScope,
  ForgeItem,
  ForgeItemKind
} from '../../shared/forge-inbox-types'
import type { ForgeAnalysisOutcome, ForgeAnalysisRunner } from './forge-inbox-coordinator'
import { buildForgeAnalysisPrompt, parseForgeAnalysisReply } from './forge-inbox-analysis-prompt'
import type { GitlabSnapshot } from './forge-inbox-gitlab-snapshot'
import type { ForgeInboxLedger } from './forge-inbox-ledger'

export type ForgeAnalysisTurnResult = { kind: 'reply'; text: string } | { kind: 'unknown' }

const HEAD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The host runs the protected session; this port is the adapter's only way to reach a model. */
export type ForgeAnalysisTurn = (request: {
  prompt: string
  signal: AbortSignal
  /** The Forge item the host seals into the protected session's record. */
  subject: AgentSessionProtectedAnalysis
  /** Must be called before the first message is sent so a restart resumes the same session. */
  onSession: (sessionId: string) => void
}) => Promise<ForgeAnalysisTurnResult>

export function createForgeAnalysisRunner(deps: {
  ledger: ForgeInboxLedger
  scope: ForgeInstanceScope
  readSnapshot: (item: ForgeItem, signal: AbortSignal) => Promise<GitlabSnapshot>
  turn: ForgeAnalysisTurn
}): ForgeAnalysisRunner {
  const { ledger, scope, readSnapshot, turn } = deps

  return async ({ run, signal, bindSession }): Promise<ForgeAnalysisOutcome> => {
    const item = ledger.getItem(scope, run.itemId)
    if (!item) {
      throw new Error('forge_analysis_item_missing')
    }
    if (signal.aborted) {
      return { kind: 'unknown' }
    }
    const snapshot = await readSnapshot(item, signal)
    // A head that moved after the claim is not the context this run paid for; the newer revision
    // queues its own run, so this one is never sent again.
    if (snapshot.versionToken !== run.contextDigest || signal.aborted) {
      return { kind: 'unknown' }
    }
    const prompt = buildForgeAnalysisPrompt({
      item: { kind: item.kind, iid: item.iid, title: snapshot.title, state: snapshot.itemState },
      reason: run.reason,
      snapshot
    })
    const outcome = await turn({
      prompt,
      signal,
      subject: {
        ownerId: item.hostId,
        instanceId: item.instanceId,
        itemId: String(item.id),
        analysisKind: item.kind
      },
      onSession: bindSession
    })
    if (outcome.kind === 'unknown') {
      return { kind: 'unknown' }
    }
    const result = parseForgeAnalysisReply(outcome.text)
    const draft = commentDraftContext(item.kind, snapshot, result)
    return { kind: 'analysed', result, ...(draft === null ? {} : { commentDraft: draft }) }
  }
}

/**
 * Which head an approval of this draft must still match. A merge request whose head this host could
 * not read gets no bindable draft; an issue has no head. Pipelines have no comment target.
 */
function commentDraftContext(
  kind: ForgeItemKind,
  snapshot: GitlabSnapshot,
  result: ForgeAnalysisResult
): { headSha: string | null } | null {
  if (result.draft === undefined || result.draft.trim() === '') {
    return null
  }
  if (kind === 'issue') {
    return { headSha: null }
  }
  if (kind !== 'merge_request') {
    return null
  }
  const subject = snapshot.subject
  if (subject?.kind !== 'merge_request') {
    return null
  }
  const sha = subject.mergeRequest.sha
  return sha !== null && HEAD_SHA.test(sha) ? { headSha: sha } : null
}
