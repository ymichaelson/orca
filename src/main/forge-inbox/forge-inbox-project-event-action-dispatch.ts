import { FORGE_PROVISIONAL_REVISION_PREFIX } from '../../shared/forge-inbox-types'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { settleDispatchConfirmationNoClaim } from './forge-inbox-dispatch-confirmation'
import type { ProjectEventActionDeps } from './forge-inbox-project-event-action-fetch-context'
import type { ProjectEventAgentLaunchResult } from './forge-inbox-project-event-agent-launch'
import { buildProjectEventDispatchPrompt } from './forge-inbox-project-event-dispatch-prompt'
import type { ProjectEventActionClaim } from './forge-inbox-project-event-action-types'
import { resolveProjectEventDispatchPolicy } from './forge-inbox-project-event-dispatch-policy'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-run-reason'
import {
  projectEventDispatchHead,
  reserveProjectEventDispatch
} from './forge-inbox-project-event-reservation'
import { failQuestionTurn } from './forge-inbox-project-event-question-preparation'
import type { ProjectEventQuestionAttempt } from './forge-inbox-project-event-question-task'
import { readForgeRun, transitionForgeRun } from './forge-inbox-runs'

export { PROJECT_EVENT_DISPATCH_RUN_REASON }

type ProjectEventDispatchDeps = Pick<
  ProjectEventActionDeps,
  'observeContext' | 'launchAgentFactory' | 'launchAgentOpener' | 'launchAgentLedger'
>

type ProjectEventDispatchOutcome =
  | { kind: 'done'; runId: number }
  | { kind: 'preparing' }
  | { kind: 'queued' }
  | { kind: 'blocked'; code: string }

function blocked(code: string): Extract<ProjectEventDispatchOutcome, { kind: 'blocked' }> {
  return { kind: 'blocked', code }
}

/** The launcher stopped before sending, because its policy or its owner went away; that is a cancellation. */
const UNSENT_LAUNCH_CODES: ReadonlySet<string> = new Set(['policy-revoked', 'owner-stopped'])

function failRun(ctx: ForgeLedgerContext, runId: number, code: string): void {
  const run = readForgeRun(ctx, runId)
  if (run?.state === 'running') {
    transitionForgeRun(ctx, runId, {
      to: UNSENT_LAUNCH_CODES.has(code) ? 'cancelled' : 'failed',
      error: code,
      expectedGeneration: run.generation
    })
    // A failed send reached no agent, so there is nothing on GitLab to confirm.
    settleDispatchConfirmationNoClaim(ctx, runId)
  }
}

/**
 * Observe before paying, launch once, and record the run's real identity. A terminal launch has no
 * session id to record; a failed or undelivered launch never settles the action as done.
 */
export async function dispatchProjectEventAgent(
  ctx: ForgeLedgerContext,
  claim: ProjectEventActionClaim,
  deps: ProjectEventDispatchDeps,
  signal?: AbortSignal,
  questionAttempt: ProjectEventQuestionAttempt = 'prepare'
): Promise<ProjectEventDispatchOutcome | null> {
  const { launchAgentFactory: factory, launchAgentLedger: factoryLedger } = deps
  if (!factory || !factoryLedger) {
    return blocked('dispatch-unavailable')
  }
  const launchAgent = deps.launchAgentOpener
    ? deps.launchAgentOpener(factory, factoryLedger)
    : factory(factoryLedger)
  let head = projectEventDispatchHead(ctx, claim)
  if (!head) {
    return blocked('invalid-input')
  }
  if (head.versionToken.startsWith(FORGE_PROVISIONAL_REVISION_PREFIX)) {
    if (!deps.observeContext) {
      return blocked('dispatch-needs-observation')
    }
    if (signal?.aborted) {
      return null
    }
    const observed = await deps.observeContext(claim, signal)
    if (signal?.aborted) {
      return null
    }
    if (!observed.ok) {
      return blocked(observed.code)
    }
    head = projectEventDispatchHead(ctx, claim)
    if (!head || head.versionToken.startsWith(FORGE_PROVISIONAL_REVISION_PREFIX)) {
      return blocked('dispatch-needs-observation')
    }
  }
  if (signal?.aborted) {
    return null
  }
  const policy = resolveProjectEventDispatchPolicy(ctx, head.itemId, claim.repoId)
  // The rules must be the ones in force when the decision was made.
  if (!policy || policy.generation !== claim.generation) {
    return blocked('dispatch-unconfigured')
  }
  let reserved: ReturnType<typeof reserveProjectEventDispatch>
  try {
    reserved = reserveProjectEventDispatch(ctx, claim, head, questionAttempt)
  } catch {
    return blocked('dispatch-failed')
  }
  if (reserved === null || reserved.kind !== 'reserved') {
    return reserved
  }
  const { runId, marker, answers } = reserved
  let result: ProjectEventAgentLaunchResult
  try {
    const prompt = buildProjectEventDispatchPrompt(
      {
        projectPath: head.projectPath,
        gitlabPath: head.gitlabPath,
        kind: head.kind,
        iid: head.iid,
        title: head.title,
        state: head.state,
        sha: head.sha,
        ...(head.ref === null ? {} : { ref: head.ref }),
        marker,
        ...(head.push === null ? {} : { push: head.push }),
        ...(head.reportedEvent === null ? {} : { reportedEvent: head.reportedEvent }),
        ...(head.trigger === null || head.trigger.kind === head.kind
          ? {}
          : { trigger: head.trigger }),
        rules: policy.rules,
        answers
      },
      claim.action === 'ask_user'
        ? questionAttempt === 'answer'
          ? 'answer'
          : 'question'
        : 'business'
    )
    result = await launchAgent({
      itemId: head.itemId,
      repoId: claim.repoId,
      runId,
      prompt,
      policyGeneration: policy.generation,
      ...(claim.action === 'ask_user' ? { requireStructuredProof: true } : {})
    })
  } catch {
    result = { ok: false, code: 'dispatch-failed' }
  }
  if (!result.ok) {
    // An uncertain send already left the run unverifiable for startup recovery; failing it would hide that.
    if (result.code !== 'unknown-outcome') {
      failRun(ctx, runId, result.code)
      if (claim.action === 'ask_user') {
        failQuestionTurn(ctx, runId, result.code)
      }
    }
    return claim.action === 'ask_user' ? { kind: 'preparing' } : blocked(result.code)
  }
  return claim.action === 'ask_user' ? { kind: 'preparing' } : { kind: 'done', runId }
}
