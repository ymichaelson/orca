import { z } from 'zod'
import { isSafeDisplayCharacter } from './skill-display-text'

export const PROJECT_EVENT_DECISION_ACTIONS = [
  'record_only',
  'notify',
  'wait',
  'fetch_context',
  'dispatch_agent',
  'ask_user'
] as const

export type ProjectEventDecisionAction = (typeof PROJECT_EVENT_DECISION_ACTIONS)[number]
export type ProjectEventDecisionProvider = 'jev' | 'laya'

// Why: the model name comes from the provider and is shown, so anything invisible or reordering is
// refused through the same display predicate that guards skill labels.
export const decisionModelTextSchema = z
  .string()
  .max(200)
  .refine((value) => [...value].every(isSafeDisplayCharacter))

const probability = z.number().finite().min(0).max(1)
const probabilitiesSchema = z.strictObject({
  record_only: probability,
  notify: probability,
  wait: probability,
  fetch_context: probability,
  dispatch_agent: probability,
  ask_user: probability
} satisfies Record<ProjectEventDecisionAction, typeof probability>)

export const projectEventDecisionResponseSchema = z.object({
  model: decisionModelTextSchema.min(1),
  answers: z.object({
    next_step: z
      .object({
        type: z.literal('choice'),
        choice: z.enum(PROJECT_EVENT_DECISION_ACTIONS),
        confidence: probability,
        probabilities: probabilitiesSchema
      })
      .superRefine((answer, ctx) => {
        const values = Object.values(answer.probabilities)
        const sum = values.reduce((total, value) => total + value, 0)
        if (Math.abs(sum - 1) > 0.01 || answer.probabilities[answer.choice] < Math.max(...values)) {
          ctx.addIssue({ code: 'custom', message: 'inconsistent decision distribution' })
        }
      })
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
})

export type ProjectEventDecisionInput = {
  rules: string
  event: Readonly<Record<string, unknown>>
  context?: Readonly<Record<string, unknown>>
}

export type ProjectEventDecisionFailureCode =
  | 'invalid-config'
  | 'invalid-input'
  | 'request-too-large'
  | 'response-too-large'
  | 'bad-response'
  | 'unauthorized'
  | 'rate-limited'
  | 'overloaded'
  | 'aborted'
  | 'timeout'
  | 'network'

export type ProjectEventDecisionResult =
  | {
      ok: true
      provider: ProjectEventDecisionProvider
      model: string
      action: ProjectEventDecisionAction
      confidence: number
      probabilities: z.infer<typeof probabilitiesSchema>
      usage: { inputTokens: number; outputTokens: number }
    }
  | { ok: false; code: ProjectEventDecisionFailureCode; retryAfterMs?: number }

/** Result of the user-triggered connection probe; never carries the key or request body. */
export type ProjectEventDecisionProbeResult =
  | { ok: true; provider: ProjectEventDecisionProvider; model: string; usedDefaultModel: boolean }
  | { ok: false; code: ProjectEventDecisionFailureCode }

export const PROJECT_EVENT_DECISION_CRITERIA: Record<ProjectEventDecisionAction, string> = {
  record_only:
    'The event is a duplicate or carries no new information: record it and take no further action.',
  notify:
    'A status notification built from already-confirmed facts is sufficient; no deeper analysis or generated prose is required.',
  wait: 'Waiting for a specific follow-up event, such as the pipeline for the latest commit finishing, the author pushing an update, or a user reply.',
  fetch_context:
    'Selectable only while context.contextFetchAvailable is true: a small, specific set of missing GitLab facts must be read before the next step can be decided. Do not guess unknown facts. Once the context rounds are exhausted, choose a different action.',
  dispatch_agent:
    'Reading changes, understanding the discussion in depth, writing a reply, or carrying out work under the project rules is required.',
  ask_user:
    'The known facts establish that the user must make a business trade-off or an explicit decision.'
}
