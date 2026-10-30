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
  record_only: '重复事件或无新增信息，只需记录，无需进一步处理。',
  notify: '只需根据已经确认的事实发送状态通知，不需要深入分析或生成复杂文本。',
  wait: '正在等待明确的后续事件，例如最新提交流水线结束、作者更新或用户回复。',
  fetch_context:
    '仅当 context.contextFetchAvailable 为 true 时可选：需要先获取少量缺失的 GitLab 事实才能决定下一步，不猜测未知事实。轮次已用尽时必须改用其他动作。',
  dispatch_agent: '需要阅读变更、深入理解讨论、撰写回复或按项目规则执行任务。',
  ask_user: '已知事实足以确定需要用户作出业务取舍或明确决定。'
}
