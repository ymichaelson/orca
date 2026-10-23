import type {
  ForgeInboxConfig,
  ForgeInboxProjectPolicy
} from '../../../../shared/forge-inbox-config'

export const FORGE_EVENT_KEYS = [
  'reviewRequests',
  'participatingMergeRequestUpdates',
  'pipelineFailures',
  'issueMentions',
  'issueAssignments'
] as const
export type ForgeEventKey = (typeof FORGE_EVENT_KEYS)[number]

export const FORGE_BUDGET_KEYS = [
  'timeoutSeconds',
  'maxInputTokens',
  'maxOutputTokens',
  'maxRunsPerHour'
] as const
export type ForgeBudgetKey = (typeof FORGE_BUDGET_KEYS)[number]

const DEFAULT_BUDGETS = {
  timeoutSeconds: 600,
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  maxRunsPerHour: 12
} as const

export function cloneForgeConfig(config: ForgeInboxConfig): ForgeInboxConfig {
  return structuredClone(config)
}

/** Commas, whitespace and newlines all separate names; case-only duplicates keep the first spelling. */
export function parseForgeUsernames(text: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.trim()
    if (name === '' || seen.has(name.toLowerCase())) {
      continue
    }
    seen.add(name.toLowerCase())
    names.push(name)
  }
  return names
}

export function formatForgeUsernames(names: readonly string[]): string {
  return names.join(', ')
}

/** A newly allowlisted project starts disabled with every event off; the user opts in explicitly. */
export function forgeNewProjectPolicy(
  projectId: string,
  repoId: string,
  workspaceId: string
): ForgeInboxProjectPolicy {
  return {
    projectId,
    repoId,
    ...(workspaceId.trim() === '' ? {} : { workspaceId: workspaceId.trim() }),
    rules: '',
    enabled: false,
    automaticAnalysis: false,
    events: {
      reviewRequests: false,
      participatingMergeRequestUpdates: false,
      pipelineFailures: false,
      issueMentions: false,
      issueAssignments: false
    },
    budgets: { ...DEFAULT_BUDGETS, maxConcurrentRuns: 1 }
  }
}

export function defaultForgeBudgets(): typeof DEFAULT_BUDGETS {
  return { ...DEFAULT_BUDGETS }
}
