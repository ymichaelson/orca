import { z } from 'zod'
import {
  forgeInboxProjectBudgetsSchema,
  forgeInboxProjectEventsSchema,
  MAX_RULES_BYTES
} from './forge-inbox-config'

// Repository-scoped body: no projectId, workspaceId or repoId is stored in the JSON, so moving a
// worktree can never fork the policy, and the durable key is the repository id alone.
export const forgeInboxProjectEventPolicyBodySchema = z
  .strictObject({
    agentId: z.string().max(100).nullable().default(null),
    model: z.string().max(200).nullable().default(null),
    rules: z
      .string()
      .default('')
      .refine((value) => !value.includes('\u0000'))
      .refine((value) => new TextEncoder().encode(value).length <= MAX_RULES_BYTES),
    enabled: z.boolean().default(false),
    automaticAnalysis: z.boolean().default(false),
    events: forgeInboxProjectEventsSchema,
    budgets: forgeInboxProjectBudgetsSchema
  })
  .superRefine((policy, ctx) => {
    if (
      policy.automaticAnalysis &&
      (policy.agentId === null ||
        policy.agentId === '' ||
        policy.model === null ||
        policy.model === '')
    ) {
      ctx.addIssue({ code: 'custom', message: 'automaticAnalysis needs an agentId and a model' })
    }
  })

export type ProjectEventPolicyBody = z.infer<typeof forgeInboxProjectEventPolicyBodySchema>

export type ProjectEventPolicyView = ProjectEventPolicyBody & {
  repoId: string
  generation: number
}

export function parseProjectEventPolicyBody(
  value: unknown
): { ok: true; policy: ProjectEventPolicyBody } | { ok: false; message: string } {
  const parsed = forgeInboxProjectEventPolicyBodySchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') ?? ''
    return { ok: false, message: `${path}: ${issue?.message ?? 'invalid'}` }
  }
  return { ok: true, policy: parsed.data }
}
