import { createHash, randomUUID } from 'node:crypto'
import type {
  ProjectEventDecisionInput,
  ProjectEventDecisionResult
} from '../../shared/project-event-decision'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { recordProjectEventItem } from './forge-inbox-project-event-delivery-item'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  projectEventDecisionFacts,
  PROJECT_EVENT_DECISION_INPUT_VERSION
} from './forge-inbox-project-event-decision-facts'
import { projectEventQuestionAnswers } from './forge-inbox-project-event-question-answer'
import { rowNumber, rowText } from './forge-inbox-rows'
import {
  finishForgeWebhookDelivery,
  forgeWebhookRetryDelayMs,
  type ForgeWebhookWorkSchedule
} from './forge-inbox-webhook-delivery-state'

const RUNNABLE = `host_id = ? AND binding_id IS NOT NULL AND state = 'pending'
  AND decision_state IN ('queued', 'retry') AND COALESCE(next_attempt_at, 0) <= ?`
const MAX_ATTEMPTS = 5

export type ProjectEventDecisionClaim = {
  deliveryId: number
  token: string
  generation: number
  repoId: string
  bindingId: string
  startedAt: number
  fingerprint: string
  input: ProjectEventDecisionInput
}

export function getProjectEventDecisionSchedule(ctx: ForgeLedgerContext): ForgeWebhookWorkSchedule {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS pending,
    MIN(COALESCE(next_attempt_at, admitted_at)) AS next_at FROM webhook_deliveries
    WHERE host_id = ? AND binding_id IS NOT NULL AND state = 'pending'
      AND decision_state IN ('queued', 'retry')`)
    .get(ctx.hostId)
  return {
    pending: row ? rowNumber(row, 'pending') : 0,
    needsAuth: 0,
    nextAttemptAtMs: row && row.next_at !== null ? rowNumber(row, 'next_at') : null
  }
}

export function claimProjectEventDecision(
  ctx: ForgeLedgerContext
): ProjectEventDecisionClaim | null {
  // Avoid publishing an empty transaction hint back into the owner's wake subscription.
  if (
    !ctx.db
      .prepare(`SELECT 1 FROM webhook_deliveries WHERE ${RUNNABLE} LIMIT 1`)
      .get(ctx.hostId, ctx.now())
  ) {
    return null
  }
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE ${RUNNABLE} ORDER BY id LIMIT 1`)
      .get(ctx.hostId, ctx.now())
    if (!row) {
      return null
    }
    const deliveryId = rowNumber(row, 'id')
    const bindingId = rowText(row, 'binding_id')
    const link = getProjectEventRepoLinkByBinding(ctx, bindingId)
    const policy = link ? getProjectEventPolicy(ctx, link.repoId) : null
    if (!policy || !link) {
      ctx.db
        .prepare(`UPDATE webhook_deliveries SET decision_state = 'blocked', state = 'parked',
        parked_reason = 'awaiting-policy', last_error_code = 'missing-policy' WHERE id = ?`)
        .run(deliveryId)
      return null
    }
    if (!policy.enabled) {
      ctx.db
        .prepare(`UPDATE webhook_deliveries SET decision_state = 'cancelled',
        last_error_code = 'policy-disabled' WHERE id = ?`)
        .run(deliveryId)
      // Nothing will ever decide this row, so it must not keep its pending slot and payload.
      finishForgeWebhookDelivery(ctx, deliveryId, 'failed', 'policy-disabled')
      return null
    }
    const binding = ctx.db
      .prepare(`SELECT project_path, gitlab_host, gitlab_path, gitlab_project_id
      FROM project_bindings WHERE binding_id = ?`)
      .get(bindingId)
    let event: Record<string, unknown>
    try {
      event = projectEventDecisionFacts(row.body)
    } catch {
      ctx.db
        .prepare(
          `UPDATE webhook_deliveries SET decision_state = 'blocked', last_error_code = 'invalid-input' WHERE id = ?`
        )
        .run(deliveryId)
      // The stored body can never be decided, so the delivery must not keep its queue slot or payload.
      finishForgeWebhookDelivery(ctx, deliveryId, 'failed', 'invalid-input')
      return null
    }
    let answers: ReturnType<typeof projectEventQuestionAnswers>
    try {
      answers = projectEventQuestionAnswers(ctx, deliveryId, policy.generation)
    } catch {
      ctx.db
        .prepare(`UPDATE webhook_deliveries SET decision_state = 'blocked',
        last_error_code = 'invalid-input' WHERE id = ?`)
        .run(deliveryId)
      finishForgeWebhookDelivery(ctx, deliveryId, 'failed', 'invalid-input')
      return null
    }
    const input: ProjectEventDecisionInput = {
      rules: policy.rules,
      event: { eventKind: rowText(row, 'event_kind'), ...event },
      context: {
        repoId: link.repoId,
        bindingId,
        policyGeneration: policy.generation,
        projectPath: binding?.project_path,
        gitlabHost: binding?.gitlab_host,
        gitlabPath: binding?.gitlab_path,
        gitlabProjectId: binding?.gitlab_project_id,
        ...(answers.length === 0 ? {} : { answers })
      }
    }
    const token = randomUUID()
    const startedAt = ctx.now()
    ctx.db
      .prepare(`UPDATE webhook_deliveries SET decision_state = 'processing', decision_token = ?,
      decision_started_at = ?, decision_generation = ?, decision_repo_id = ?, policy_generation = ?,
      attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?`)
      .run(token, startedAt, policy.generation, link.repoId, policy.generation, deliveryId)
    return {
      deliveryId,
      token,
      startedAt,
      generation: policy.generation,
      repoId: link.repoId,
      bindingId,
      input,
      fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex')
    }
  })
}

export type ProjectEventDecisionOutcome =
  | { ok: true; action: Extract<ProjectEventDecisionResult, { ok: true }>['action'] }
  | { ok: false; reason: 'not-found' | 'decision-failed' }

export function decideProjectEventDelivery(
  ctx: ForgeLedgerContext,
  deliveryId: number,
  decision: ProjectEventDecisionResult,
  claim?: ProjectEventDecisionClaim
): ProjectEventDecisionOutcome {
  if (!claim || claim.deliveryId !== deliveryId) {
    return { ok: false, reason: 'not-found' }
  }
  return runForgeTransaction(ctx.db, (): ProjectEventDecisionOutcome => {
    const row = ctx.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id = ? AND host_id = ?`)
      .get(deliveryId, ctx.hostId)
    if (!row) {
      return { ok: false, reason: 'not-found' }
    }
    const link = getProjectEventRepoLinkByBinding(ctx, claim.bindingId)
    const policy = link ? getProjectEventPolicy(ctx, link.repoId) : null
    const current =
      row.decision_token === claim.token &&
      row.decision_state === 'processing' &&
      row.decision_generation === claim.generation &&
      row.state === 'pending' &&
      link?.repoId === claim.repoId &&
      policy?.enabled === true &&
      policy.generation === claim.generation
    let decisionId = 0
    if (decision.ok) {
      const inserted = ctx.db
        .prepare(`INSERT INTO project_event_decisions (host_id, delivery_id, policy_generation,
        provider, model, action, confidence, input_tokens, output_tokens, decided_at, attempt_token,
        input_fingerprint, input_version, duration_ms, superseded, action_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          ctx.hostId,
          deliveryId,
          claim.generation,
          decision.provider,
          decision.model,
          decision.action,
          decision.confidence,
          decision.usage.inputTokens,
          decision.usage.outputTokens,
          ctx.now(),
          claim.token,
          claim.fingerprint,
          PROJECT_EVENT_DECISION_INPUT_VERSION,
          Math.max(0, ctx.now() - claim.startedAt),
          current ? 0 : 1,
          decision.action === 'record_only' ? 'done' : 'queued'
        )
      decisionId = rowNumber({ id: inserted.lastInsertRowid }, 'id')
    }
    if (!current) {
      return { ok: false, reason: 'not-found' }
    }
    if (!decision.ok) {
      const attempts = rowNumber(row, 'attempts')
      const transient = ['rate-limited', 'overloaded', 'timeout', 'network'].includes(decision.code)
      const retry = transient && attempts < MAX_ATTEMPTS
      const retryAfter = Number.isFinite(decision.retryAfterMs)
        ? Math.min(300_000, Math.max(0, decision.retryAfterMs ?? 0))
        : 0
      ctx.db
        .prepare(`UPDATE webhook_deliveries SET decision_state = ?, decision_token = NULL,
        next_attempt_at = ? WHERE id = ?`)
        .run(
          retry ? 'retry' : 'blocked',
          retry ? ctx.now() + Math.max(forgeWebhookRetryDelayMs(attempts), retryAfter) : null,
          deliveryId
        )
      if (retry) {
        ctx.db
          .prepare('UPDATE webhook_deliveries SET last_error_code = ? WHERE id = ?')
          .run(decision.code, deliveryId)
      } else {
        // No later attempt is coming, so this row would otherwise hold a queue slot forever.
        finishForgeWebhookDelivery(ctx, deliveryId, 'failed', decision.code)
      }
      return { ok: false, reason: 'decision-failed' }
    }
    const finish = decision.action === 'record_only'
    const refusal = recordProjectEventItem(ctx, {
      deliveryId,
      bindingId: claim.bindingId,
      decisionId,
      notify: decision.action === 'notify',
      allowUnknown: finish
    })
    ctx.db
      .prepare(`UPDATE webhook_deliveries SET decision_state = 'decided', decision_token = NULL,
      last_error_code = ?, next_attempt_at = NULL, state = ?, finished_at = ?, body = CASE WHEN ? THEN x'' ELSE body END WHERE id = ?`)
      .run(
        refusal,
        finish ? 'done' : 'pending',
        finish ? ctx.now() : null,
        finish ? 1 : 0,
        deliveryId
      )
    return { ok: true, action: decision.action }
  })
}

export function recoverInterruptedProjectEventDecisions(ctx: ForgeLedgerContext): void {
  // The interrupted claim wrote nothing, so the event is still undecided: blocking it would strand a
  // pending row that no claim, schedule, or resume path ever picks up again.
  ctx.db
    .prepare(`UPDATE webhook_deliveries SET decision_state = 'queued', decision_token = NULL,
    next_attempt_at = NULL, last_error_code = 'interrupted-decision' WHERE host_id = ?
    AND binding_id IS NOT NULL AND state = 'pending' AND decision_state = 'processing'`)
    .run(ctx.hostId)
}
