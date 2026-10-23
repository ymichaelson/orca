import type { AgentSessionProtectedAnalysis } from '../../shared/agent-session-protected-analysis'
import type { ForgeInboxProjectPolicy } from '../../shared/forge-inbox-config'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeAnalysisTurn } from './forge-inbox-analysis-runner'
import {
  createForgeProtectedAnalysisTurn,
  type ForgeProtectedAnalysisFounding,
  type ForgeProtectedAnalysisTurnDeps
} from './forge-inbox-protected-turn'

export type ForgeAnalysisLaunch = {
  instanceId: string
  projectId: string
  workspaceId: string | null
  agentId: string
  model: string
  budgets: ForgeInboxProjectPolicy['budgets']
}

type LaunchLedger = Pick<ForgeInboxLedger, 'getItem' | 'getConfig'>

/**
 * Read at launch rather than from the queued run: the rules that pay for a session are whatever the
 * owner configured when it starts, and a project that is now off must not launch at all.
 */
export function resolveForgeAnalysisLaunch(
  ledger: LaunchLedger,
  subject: AgentSessionProtectedAnalysis
): ForgeAnalysisLaunch {
  const item = ledger.getItem({ instanceId: subject.instanceId }, Number(subject.itemId))
  if (!item) {
    throw new Error('forge_analysis_item_missing')
  }
  if (
    item.hostId !== subject.ownerId ||
    item.instanceId !== subject.instanceId ||
    item.kind !== subject.analysisKind
  ) {
    throw new Error('forge_analysis_subject_mismatch')
  }
  const instance = ledger
    .getConfig()
    .config.instances.find((candidate) => candidate.id === item.instanceId)
  const project = instance?.projects.find((candidate) => candidate.projectId === item.projectId)
  if (!project) {
    throw new Error('forge_analysis_project_missing')
  }
  if (!project.enabled || !project.automaticAnalysis) {
    throw new Error('forge_analysis_policy_disabled')
  }
  if (!project.agentId || !project.model) {
    throw new Error('forge_analysis_policy_incomplete')
  }
  return {
    instanceId: item.instanceId,
    projectId: item.projectId,
    workspaceId: project.workspaceId ?? null,
    agentId: project.agentId,
    model: project.model,
    budgets: project.budgets
  }
}

/**
 * Host-free half of the real turn: the host still prepares the founding and opens the session, but
 * neither the agent nor the model can come from anywhere except the policy resolved here.
 */
export function createForgeAnalysisFoundFor(deps: {
  ledger: LaunchLedger
  prepare: (input: {
    sessionId: string
    subject: AgentSessionProtectedAnalysis
    launch: ForgeAnalysisLaunch
  }) => Promise<ForgeProtectedAnalysisFounding>
}): ForgeProtectedAnalysisTurnDeps['foundFor'] {
  return async ({ sessionId, subject }) => {
    const launch = resolveForgeAnalysisLaunch(deps.ledger, subject)
    const founding = await deps.prepare({ sessionId, subject, launch })
    // The founding could be prepared for another model; running it would spend money outside policy.
    if (founding.options.model !== launch.model) {
      throw new Error('forge_analysis_founding_model_mismatch')
    }
    return founding
  }
}

/** The whole analysis turn a host injects as `analyse`: policy in, protected session out. */
export function createForgeInboxAnalysisTurn(deps: {
  ledger: LaunchLedger
  prepare: Parameters<typeof createForgeAnalysisFoundFor>[0]['prepare']
  openSession: ForgeProtectedAnalysisTurnDeps['openSession']
}): ForgeAnalysisTurn {
  return createForgeProtectedAnalysisTurn({
    foundFor: createForgeAnalysisFoundFor({ ledger: deps.ledger, prepare: deps.prepare }),
    openSession: deps.openSession
  })
}
