import { parseForgeInboxConfig } from '../../shared/forge-inbox-config'
import { forgeProjectPolicyPatchSchema } from '../../shared/forge-inbox-project-policy-patch'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { commitForgeConfigInTransaction, readForgeConfigState } from './forge-inbox-config'
import { runForgeTransaction } from './forge-inbox-database'
import { bumpForgePolicyGenerationInTransaction } from './forge-inbox-policy'

/** Copies defined keys only, so an explicit undefined can never overwrite a current setting. */
function mergeDefined<T extends object>(base: T, patch: object | undefined): T {
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) {
      Object.defineProperty(merged, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
  }
  return merged
}

export type ForgeProjectPolicyUpdateInput = {
  instanceId: string
  projectId: string
  patch: unknown
}

export type ForgeProjectPolicyUpdateResult =
  | { ok: true; configRevision: number }
  | { ok: false; reason: 'stale-revision'; configRevision: number }
  | { ok: false; reason: 'invalid-config'; message: string }
  | { ok: false; reason: 'project-not-found' }

/** Edits one allowlisted project's policy; mapping and host-level fields are not patchable. */
export function updateForgeProjectPolicy(
  ctx: ForgeLedgerContext,
  expectedRevision: number,
  input: ForgeProjectPolicyUpdateInput
): ForgeProjectPolicyUpdateResult {
  const patch = forgeProjectPolicyPatchSchema.safeParse(input.patch)
  if (!patch.success) {
    return { ok: false, reason: 'invalid-config', message: patch.error.message }
  }
  return runForgeTransaction(ctx.db, (): ForgeProjectPolicyUpdateResult => {
    const current = readForgeConfigState(ctx)
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'stale-revision', configRevision: current.revision }
    }
    const draft = structuredClone(current.config)
    const project = draft.instances
      .find((instance) => instance.id === input.instanceId)
      ?.projects.find((candidate) => candidate.projectId === input.projectId)
    if (!project) {
      return { ok: false, reason: 'project-not-found' }
    }
    const { agentId, model, events, budgets, ...scalars } = patch.data
    const { rules, enabled, automaticAnalysis } = scalars
    project.rules = rules ?? project.rules
    project.enabled = enabled ?? project.enabled
    project.automaticAnalysis = automaticAnalysis ?? project.automaticAnalysis
    if (agentId === null) {
      delete project.agentId
    } else if (agentId !== undefined) {
      project.agentId = agentId
    }
    if (model === null) {
      delete project.model
    } else if (model !== undefined) {
      project.model = model
    }
    project.events = mergeDefined(project.events, events)
    project.budgets = mergeDefined(project.budgets, budgets)
    const parsed = parseForgeInboxConfig(draft)
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid-config', message: parsed.message }
    }
    if (JSON.stringify(parsed.config) === JSON.stringify(current.config)) {
      return { ok: true, configRevision: current.revision }
    }
    const configRevision = commitForgeConfigInTransaction(ctx, current.revision, parsed.config)
    bumpForgePolicyGenerationInTransaction(ctx, input)
    return { ok: true, configRevision }
  })
}
