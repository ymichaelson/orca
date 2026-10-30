import { clampUtf8TextPrefix } from './utf8-byte-limits'

/** Shared by the RPC contract and the ledger so one answer bound governs both sides. */
export const FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES = 2000

/** Stored rows and older peers are bounded before their answers reach a prompt or display. */
export function projectEventAnswerText(answer: string): string {
  return clampUtf8TextPrefix(answer.replaceAll('\u0000', ''), FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES)
}

export const FORGE_PROJECT_EVENT_QUESTION_STATUSES = ['open', 'answered'] as const

export type ProjectEventQuestionStatus = (typeof FORGE_PROJECT_EVENT_QUESTION_STATUSES)[number]

/**
 * The item a question is about. A host-written fallback renders from these facts in the reader's
 * language; a task's own question is shown as it was asked. The title stays untrusted plain data.
 */
export type ProjectEventQuestionSubject = {
  kind: string
  iid: number
  title: string
}

export const FORGE_PROJECT_EVENT_QUESTION_SOURCES = ['answer', 'exhausted'] as const

/**
 * Why a question could not be asked yet: 'answer' waits for a minimal task to answer it, 'exhausted'
 * means every attempt declined. A client renders both in its own locale.
 */
export type ProjectEventQuestionSource = (typeof FORGE_PROJECT_EVENT_QUESTION_SOURCES)[number]

/** GitLab's own reference prefixes: merge requests are !7, issues and pipelines #7, a project has none. */
export function projectEventSubjectReference(kind: string, iid: number): string {
  if (kind === 'project') {
    return ''
  }
  return `${kind === 'issue' || kind === 'pipeline' ? '#' : '!'}${iid}`
}

export type ProjectEventQuestionView = {
  id: number
  itemId: number
  question: string
  subject: ProjectEventQuestionSubject | null
  /** 'answer' means a task asked this, so its text is the sentence; null predates the column. */
  source: ProjectEventQuestionSource | null
  status: ProjectEventQuestionStatus
  askedAt: number
  answeredAt: number | null
}

export type ProjectEventQuestionAnswerOutcome =
  | { ok: true; question: ProjectEventQuestionView }
  | { ok: false; reason: 'not-found' | 'question-answer-invalid' }
