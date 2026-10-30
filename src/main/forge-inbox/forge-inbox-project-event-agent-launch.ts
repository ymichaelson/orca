import type { TuiAgent } from '../../shared/tui-agent'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createStructuredAgentSessionForWorktree } from '../runtime/rpc/methods/structured-agent-session-create'
import { commitStructuredAgentSessionLaunchPrompt } from '../runtime/rpc/methods/agent-launch-structured-prompt'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  admissionError,
  surfacesFor,
  requireStructuredHost,
  type LaunchAdmission
} from './forge-inbox-project-event-agent-launch-surfaces'
import type {
  ForgeProjectEventAgentLaunchFactory,
  ProjectEventAgentLaunch,
  ProjectEventAgentLaunchPorts,
  ProjectEventAgentLaunchResult
} from './forge-inbox-project-event-agent-launch-types'
import { resolveRepoWorkspace } from './forge-inbox-project-event-agent-launch-workspace'
import {
  createForgeProjectEventRunCancel,
  type ProjectEventRunCancel
} from './forge-inbox-project-event-run-cancel'
import { bindDispatchSnapshot } from './forge-inbox-project-event-run-terminal-state'
import { createForgeProjectEventTerminalObserver } from './forge-inbox-project-event-terminal-observer'
import {
  projectEventRunCancelRuntimeFor,
  projectEventTerminalRuntimeFor,
  reportedModelOfStructuredSession
} from './forge-inbox-project-event-run-cancel-runtime'
import { createForgeProjectEventRunHostWatch } from './forge-inbox-project-event-run-host-watch'
import { resolveProjectEventDispatchPolicy } from './forge-inbox-project-event-dispatch-policy'
import {
  markForgeRunUnverifiableIfRunning,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'

export type {
  ForgeProjectEventAgentLaunchFactory,
  ForgeProjectEventAgentLaunchOpener,
  ProjectEventAgentLaunch,
  ProjectEventAgentLaunchInput,
  ProjectEventAgentLaunchPorts,
  ProjectEventAgentLaunchResult,
  ProjectEventAgentLaunchRuntime,
  ProjectEventStructuredSessionCreate
} from './forge-inbox-project-event-agent-launch-types'

type DispatchPolicy = {
  agentId: TuiAgent
  model: string | null
}

/** Codes our own launch path throws; any other message is not ours to surface. */
const KNOWN_LAUNCH_ERROR_CODES: ReadonlySet<string> = new Set([
  'policy_revoked',
  'owner_stopped',
  'dispatch_session_unbound',
  'dispatch_turn_unbound',
  'structured_agent_session_unsupported',
  'dispatch_prompt_too_large_for_terminal'
])

function fixedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Stored action codes allow only [a-z0-9-].
  return KNOWN_LAUNCH_ERROR_CODES.has(message) ? message.replaceAll('_', '-') : 'dispatch-failed'
}

/** Production wiring: the same host calls every other launch uses, plus the caller-minted session id. */
export function forgeInboxProjectEventAgentLaunchForRuntime(
  runtime: OrcaRuntimeService
): ForgeProjectEventAgentLaunchFactory {
  return (ledger) => {
    const launch = createForgeProjectEventAgentLaunch(ledger, {
      runtime,
      createStructuredSession: (args) =>
        createStructuredAgentSessionForWorktree({ ...args, runtime }),
      deliverStructuredPrompt: async ({ callerKey, ...prompt }) =>
        commitStructuredAgentSessionLaunchPrompt({
          ...prompt,
          host: requireStructuredHost(),
          caller: { callerKey }
        }),
      runWatch: createForgeProjectEventRunHostWatch(ledger),
      cancel: projectEventRunCancelRuntimeFor(runtime),
      terminals: projectEventTerminalRuntimeFor(runtime),
      reportedModel: reportedModelOfStructuredSession
    })
    return launch
  }
}

export function createForgeProjectEventAgentLaunch(
  ledger: ForgeInboxLedger,
  ports: ProjectEventAgentLaunchPorts
): ProjectEventAgentLaunch {
  const ctx = ledger.ledgerContext()
  let stopped = false
  // Close ends any wait a dispatch is in, so the run cannot outlive the owner that opened it.
  const ownerStopped = new AbortController()
  const untilOwnerStops = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const refuse = (): void => reject(admissionError('owner-stopped'))
      if (ownerStopped.signal.aborted) {
        refuse()
        return
      }
      ownerStopped.signal.addEventListener('abort', refuse, { once: true })
      work.then(resolve, reject).finally(() => {
        ownerStopped.signal.removeEventListener('abort', refuse)
      })
    })
  const launch: ProjectEventAgentLaunch = async ({
    itemId,
    repoId,
    runId,
    prompt,
    policyGeneration,
    requireStructuredProof
  }) => {
    let sendAttempted = false
    const undelivered = (code: string): ProjectEventAgentLaunchResult => {
      if (sendAttempted && !ledger.isClosed()) {
        markForgeRunUnverifiableIfRunning(ctx, runId)
        return { ok: false, code: 'unknown-outcome' }
      }
      return { ok: false, code }
    }
    if (stopped || ledger.isClosed()) {
      return { ok: false, code: 'owner-stopped' }
    }
    const resolved = resolveProjectEventDispatchPolicy(ctx, itemId, repoId)
    if (!resolved || (policyGeneration !== undefined && resolved.generation !== policyGeneration)) {
      return { ok: false, code: 'dispatch-unconfigured' }
    }
    const policy: DispatchPolicy = { agentId: resolved.agentId, model: resolved.model }
    // Every awaited step below can outlive the policy, the run and this launcher.
    const admit: LaunchAdmission = () => {
      if (stopped || ledger.isClosed()) {
        return 'owner-stopped'
      }
      const current = resolveProjectEventDispatchPolicy(ctx, itemId, repoId)
      if (current?.generation !== resolved.generation) {
        return 'policy-revoked'
      }
      const run = ctx.db
        .prepare(`SELECT r.state, r.cancel_requested_at, r.context_digest,
        head.version_token FROM runs r JOIN items i ON i.id = r.item_id
        JOIN item_revisions head ON head.item_id = i.id AND head.revision = i.current_revision
        WHERE r.id = ? AND i.host_id = ?`)
        .get(runId, ctx.hostId)
      const revokedDecision = ctx.db
        .prepare(`SELECT 1 FROM project_event_decisions
        WHERE host_id = ? AND run_id = ? AND superseded <> 0 LIMIT 1`)
        .get(ctx.hostId, runId)
      if (
        !run ||
        run.state !== 'running' ||
        run.cancel_requested_at !== null ||
        run.context_digest !== run.version_token ||
        revokedDecision
      ) {
        return 'policy-revoked'
      }
      return null
    }
    let workspace: Awaited<ReturnType<typeof resolveRepoWorkspace>>
    try {
      workspace = await untilOwnerStops(resolveRepoWorkspace(ports.runtime, repoId))
    } catch (error) {
      return undelivered(fixedErrorCode(error))
    }
    const revoked = admit()
    if (revoked) {
      return { ok: false, code: revoked }
    }
    if (readForgeRun(ctx, runId)?.state !== 'running') {
      return { ok: false, code: 'dispatch-failed' }
    }
    // The dispatch boundary: from here an effect may happen, so what it was told to use is kept.
    bindDispatchSnapshot(ctx, runId, { agentId: policy.agentId, requestedModel: policy.model })
    if (!workspace.ok) {
      return { ok: false, code: workspace.code }
    }
    const workspaceId = workspace.worktreeId
    const callerKey = `forge-dispatch:${runId}`
    let result: Awaited<ReturnType<typeof executeAgentLaunch>>
    try {
      result = await untilOwnerStops(
        executeAgentLaunch({
          runtime: ports.runtime,
          intent: {
            agent: policy.agentId,
            target: { kind: 'existing', worktree: workspaceId },
            ...(policy.model ? { sessionOptions: { model: policy.model } } : {}),
            prompt: { text: prompt, delivery: 'submit' },
            launchSource: 'forge-project-event'
          },
          surfaces: surfacesFor({
            ctx,
            ports,
            runId,
            promptText: prompt,
            callerKey,
            admit,
            requireStructuredProof,
            onSendAttempted: () => {
              sendAttempted = true
            }
          })
        })
      )
    } catch (error) {
      return undelivered(fixedErrorCode(error))
    }
    const receipt = result.prompt
    if (receipt?.delivery !== 'submit') {
      return undelivered('dispatch-prompt-undelivered')
    }
    if (result.outcome.kind === 'structured') {
      if (receipt.outcome !== 'journaled') {
        return undelivered('dispatch-prompt-undelivered')
      }
      return {
        ok: true,
        mode: 'structured',
        sessionId: result.outcome.sessionId,
        promptOutcome: 'journaled'
      }
    }
    if (receipt.outcome !== 'handed-to-terminal') {
      return { ok: false, code: 'dispatch-prompt-undelivered' }
    }
    // A terminal has no reply channel here, so the run says its result was never collected.
    const run = readForgeRun(ctx, runId)
    if (run?.state === 'running') {
      transitionForgeRun(ctx, runId, {
        to: 'unverifiable',
        error: 'terminal-handoff',
        expectedGeneration: run.generation
      })
      observer?.wake()
    }
    return { ok: true, mode: 'terminal', sessionId: null, promptOutcome: 'handed-to-terminal' }
  }
  const canceller: ProjectEventRunCancel | null = ports.cancel
    ? createForgeProjectEventRunCancel({
        ledger,
        runtime: ports.cancel,
        ...(ports.runWatch ? { runWatch: ports.runWatch } : {}),
        ...(ports.cancelRetryDelayMs === undefined
          ? {}
          : { retryDelayMs: ports.cancelRetryDelayMs })
      })
    : null
  const observer = ports.terminals
    ? createForgeProjectEventTerminalObserver({ ledger, runtime: ports.terminals })
    : null
  launch.stop = async () => {
    stopped = true
    ownerStopped.abort()
    await Promise.all([canceller?.stop(), observer?.stop()])
  }
  launch.dispose = () => ports.runWatch?.dispose()
  return launch
}
