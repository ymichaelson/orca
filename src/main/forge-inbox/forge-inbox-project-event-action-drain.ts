import type { ForgeLedgerContext } from './forge-inbox-context'
import {
  claimProjectEventAction,
  getProjectEventActionSchedule,
  linkProjectEventDecisionItem,
  settleProjectEventAction,
  PROJECT_EVENT_WIRED_ACTIONS,
  type ProjectEventActionClaim,
  type ProjectEventActionItemLinkResult,
  type ProjectEventActionOutcome,
  type ProjectEventQuestionPrompt
} from './forge-inbox-project-event-action'
import { dispatchProjectEventAgent } from './forge-inbox-project-event-action-dispatch'
import {
  projectEventQuestionRound,
  projectEventQuestionSubject,
  projectEventQuestionText
} from './forge-inbox-project-event-action-question'
import { projectEventQuestionAttempts } from './forge-inbox-project-event-question-preparation'
import {
  fetchProjectEventContext,
  type ProjectEventActionDeps
} from './forge-inbox-project-event-action-fetch-context'

export { PROJECT_EVENT_WIRED_ACTIONS }
export type { ProjectEventActionDeps }

/** Only the launcher wiring crosses to the dispatch; its own deps never widen the drain's. */
function dispatchDepsOf(deps: ProjectEventActionDeps) {
  return {
    ...(deps.observeContext ? { observeContext: deps.observeContext } : {}),
    ...(deps.launchAgentFactory ? { launchAgentFactory: deps.launchAgentFactory } : {}),
    ...(deps.launchAgentOpener ? { launchAgentOpener: deps.launchAgentOpener } : {}),
    ...(deps.launchAgentLedger ? { launchAgentLedger: deps.launchAgentLedger } : {})
  }
}

const MAX_PER_DRAIN = 8
const MAX_WAIT_REASON_LENGTH = 200

export type ProjectEventActionDrain = { executed: number; failed: number; capped: boolean }

function mergeHasConflict(facts: Record<string, unknown>): boolean {
  const status = typeof facts.mergeStatus === 'string' ? facts.mergeStatus : ''
  return facts.hasConflicts === true || status === 'cannot_be_merged' || status === 'conflict'
}

/** Deterministic from what the delivery reported: a wait names the change that must arrive. */
export function projectEventWaitReason(facts: Record<string, unknown>): string {
  const kind = typeof facts.kind === 'string' ? facts.kind : ''
  const status =
    typeof facts.status === 'string'
      ? facts.status
      : typeof facts.state === 'string'
        ? facts.state
        : ''
  const reason =
    kind === 'pipeline' && (status === 'running' || status === 'pending')
      ? 'pipeline-finishes'
      : kind === 'merge_request' && mergeHasConflict(facts)
        ? 'conflict-resolved'
        : kind === 'note'
          ? 'user-reply'
          : 'next-event'
  return reason.slice(0, MAX_WAIT_REASON_LENGTH)
}

type ProjectEventActionStep = {
  outcome: ProjectEventActionOutcome | { kind: 'preparing' }
  question?: ProjectEventQuestionPrompt
}

async function outcomeFor(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  linked: Extract<ProjectEventActionItemLinkResult, { ok: true }>,
  deps: ProjectEventActionDeps,
  signal?: AbortSignal
): Promise<ProjectEventActionStep | null> {
  if (claim.action === 'dispatch_agent') {
    const outcome = await dispatchProjectEventAgent(ctx, claim, dispatchDepsOf(deps), signal)
    return outcome === null ? null : { outcome }
  }
  if (claim.action === 'fetch_context') {
    const outcome = await fetchProjectEventContext(ctx, claim, deps, signal)
    return outcome === null ? null : { outcome }
  }
  if (claim.action === 'ask_user') {
    const round = projectEventQuestionRound(ctx, claim.deliveryId)
    if (round === 'exhausted') {
      return { outcome: { kind: 'blocked', code: 'question-rounds-exhausted' } }
    }
    if (round === 'reuse-open') {
      return { outcome: { kind: 'awaiting-user' } }
    }
    const attempt = projectEventQuestionAttempts(ctx, claim.deliveryId)
    if (attempt === 'exhausted') {
      return { outcome: { kind: 'blocked', code: 'question-unpreparable' } }
    }
    const outcome = await dispatchProjectEventAgent(
      ctx,
      claim,
      dispatchDepsOf(deps),
      signal,
      attempt
    )
    if (outcome === null) {
      return null
    }
    if (outcome.kind === 'blocked' && outcome.code === 'dispatch-unavailable') {
      // This host cannot start a task, so it asks in its own words rather than dropping the question.
      const subject = projectEventQuestionSubject(linked.facts)
      if (subject !== null) {
        return {
          outcome: { kind: 'awaiting-user' },
          question: { text: projectEventQuestionText(subject), subject }
        }
      }
    }
    return { outcome }
  }
  if (claim.action === 'wait') {
    return { outcome: { kind: 'awaiting-event', waitReason: projectEventWaitReason(linked.facts) } }
  }
  if (claim.action === 'notify') {
    return linked.notificationCategory
      ? { outcome: { kind: 'done' } }
      : { outcome: { kind: 'blocked', code: 'notification-unsupported' } }
  }
  return { outcome: { kind: 'blocked', code: 'action-unsupported' } }
}

/**
 * One action at a time: linking creates the item a wait's wake trigger keys on, so the event must
 * exist before the action is settled. A batch cap keeps one drain from starving the event loop.
 */
export async function drainProjectEventActions(
  ctx: ForgeLedgerContext,
  deps: ProjectEventActionDeps,
  signal?: AbortSignal
): Promise<ProjectEventActionDrain> {
  const result: ProjectEventActionDrain = { executed: 0, failed: 0, capped: false }
  let processed = 0
  while (processed < MAX_PER_DRAIN) {
    if (signal?.aborted) {
      return result
    }
    const claim = claimProjectEventAction(ctx)
    if (!claim) {
      break
    }
    processed += 1
    const linked = linkProjectEventDecisionItem(ctx, claim)
    if (!linked.ok) {
      result.failed += 1
      continue
    }
    let step: ProjectEventActionStep | null
    try {
      step = await outcomeFor(ctx, claim, linked, deps, signal)
    } catch {
      step = { outcome: { kind: 'blocked', code: 'action-failed' } }
    }
    // Shutdown joins this drain before closing SQLite; an ignored abort must not settle late.
    if (step === null || signal?.aborted) {
      return result
    }
    if (step.outcome.kind === 'preparing') {
      result.executed += 1
      continue
    }
    const settled = settleProjectEventAction(ctx, claim, step.outcome, step.question)
    if (settled.ok && step.outcome.kind === 'queued') {
      continue
    }
    if (settled.ok && step.outcome.kind !== 'blocked') {
      result.executed += 1
    } else {
      result.failed += 1
    }
  }
  result.capped =
    processed === MAX_PER_DRAIN &&
    !signal?.aborted &&
    getProjectEventActionSchedule(ctx).pending > 0
  return result
}
