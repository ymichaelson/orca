import { z } from 'zod'
import { MAX_RULES_BYTES } from './forge-inbox-config'

// Bare optionals on purpose: any default here would silently reset a setting the caller omitted.
// Ranges are not repeated here; the merged config is re-validated by the full config parser.
const eventsPatchSchema = z.strictObject({
  reviewRequests: z.boolean().optional(),
  participatingMergeRequestUpdates: z.boolean().optional(),
  pipelineFailures: z.boolean().optional(),
  issueMentions: z.boolean().optional(),
  issueAssignments: z.boolean().optional()
})

const budgetsPatchSchema = z.strictObject({
  timeoutSeconds: z.number().optional(),
  maxInputTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  maxRunsPerHour: z.number().optional(),
  maxConcurrentRuns: z.number().optional()
})

export const forgeProjectPolicyPatchSchema = z.strictObject({
  agentId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  rules: z
    .string()
    .refine((value) => new TextEncoder().encode(value).length <= MAX_RULES_BYTES)
    .optional(),
  enabled: z.boolean().optional(),
  automaticAnalysis: z.boolean().optional(),
  events: eventsPatchSchema.optional(),
  budgets: budgetsPatchSchema.optional()
})

export type ForgeProjectPolicyPatch = z.infer<typeof forgeProjectPolicyPatchSchema>
