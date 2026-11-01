import type { ForgeLedgerContext } from './forge-inbox-context'
import { recordForgeChange } from './forge-inbox-context'
import { runForgeTransaction } from './forge-inbox-database'
import { getProjectEventRepoLinkByBinding } from './forge-inbox-project-event-link'
import { getProjectEventPolicy } from './forge-inbox-project-event-policy'
import { rowNumber } from './forge-inbox-rows'

/** What the reader has answered on a policy question; the answer text itself is never the gate. */
export const PROJECT_EVENT_POLICY_ANSWERS = ['enable', 'decline'] as const

export type ProjectEventPolicyAnswer = (typeof PROJECT_EVENT_POLICY_ANSWERS)[number]

export type ProjectEventPolicyMissing = {
  bindingId: string
  gitlabProjectId: number
  repoId: string
}

/** Null unless the binding's repository is linked and has no policy at all. */
export function projectEventPolicyMissing(
  ctx: ForgeLedgerContext,
  bindingId: string
): ProjectEventPolicyMissing | null {
  const link = getProjectEventRepoLinkByBinding(ctx, bindingId)
  if (link === null || link.bindingId !== bindingId || getProjectEventPolicy(ctx, link.repoId)) {
    return null
  }
  const binding = ctx.db
    .prepare('SELECT gitlab_project_id FROM project_bindings WHERE binding_id = ?')
    .get(bindingId)
  const projectId = binding?.gitlab_project_id
  return typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0
    ? { bindingId, gitlabProjectId: projectId, repoId: link.repoId }
    : null
}

function policyAnswerOf(answer: unknown): ProjectEventPolicyAnswer | null {
  return PROJECT_EVENT_POLICY_ANSWERS.find((known) => known === answer) ?? null
}

function policyAnswer(ctx: ForgeLedgerContext, itemId: number): ProjectEventPolicyAnswer | null {
  const row = ctx.db
    .prepare(
      `SELECT answer FROM project_event_questions WHERE host_id = ? AND item_id = ?
       AND source = 'policy' ORDER BY id DESC LIMIT 1`
    )
    .get(ctx.hostId, itemId)
  return row ? policyAnswerOf(row.answer) : null
}

/** Runs in the caller's transaction with the item, so an item never shows without its question. */
export function askAboutMissingProjectEventPolicy(
  ctx: ForgeLedgerContext,
  itemId: number,
  missing: ProjectEventPolicyMissing
): void {
  if (policyAnswer(ctx, itemId) !== null || openPolicyQuestion(ctx, itemId)) {
    return
  }
  ask(ctx, itemId, missing)
}

function openPolicyQuestion(ctx: ForgeLedgerContext, itemId: number): boolean {
  return (
    ctx.db
      .prepare(
        `SELECT 1 FROM project_event_questions WHERE host_id = ? AND item_id = ?
         AND source = 'policy' AND status = 'open' LIMIT 1`
      )
      .get(ctx.hostId, itemId) !== undefined
  )
}

function ask(ctx: ForgeLedgerContext, itemId: number, missing: ProjectEventPolicyMissing): void {
  const inserted = ctx.db
    .prepare(`INSERT INTO project_event_questions (host_id, delivery_id, decision_id, item_id,
      question, subject_kind, subject_iid, subject_title, source, policy_repo_id, status, asked_at)
      VALUES (?, 0, 0, ?, ?, 'project', 0, ?, 'policy', ?, 'open', ?)`)
    .run(
      ctx.hostId,
      itemId,
      'This repository has no agent policy yet, so Orca cannot hand this event to an agent. Turn on the policy for this project to decide what happens with events like this, now and later?',
      String(missing.gitlabProjectId),
      missing.repoId,
      ctx.now()
    )
  recordForgeChange(
    ctx,
    itemId,
    'question',
    rowNumber({ v: inserted.lastInsertRowid }, 'v'),
    'opened'
  )
}

/**
 * An answer records the reader's choice on the item; it never becomes prompt text. Enabling the policy
 * is a separate policy write, so a client that lacks the repo's policy editor cannot change it here.
 */
export function answerProjectEventPolicyQuestion(
  ctx: ForgeLedgerContext,
  questionId: number,
  answer: ProjectEventPolicyAnswer
): { repoId: string | null } {
  return runForgeTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare(
        `SELECT item_id, policy_repo_id FROM project_event_questions
         WHERE id = ? AND host_id = ? AND source = 'policy' AND status = 'open'`
      )
      .get(questionId, ctx.hostId)
    if (!row) {
      return { repoId: null }
    }
    ctx.db
      .prepare(
        `UPDATE project_event_questions SET status = 'answered', answer = ?, answered_at = ?
         WHERE id = ? AND host_id = ? AND source = 'policy' AND status = 'open'`
      )
      .run(answer, ctx.now(), questionId, ctx.hostId)
    recordForgeChange(ctx, rowNumber(row, 'item_id'), 'question', questionId, 'answered')
    const repoId = row.policy_repo_id
    return { repoId: typeof repoId === 'string' && repoId !== '' ? repoId : null }
  })
}
