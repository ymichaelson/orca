import {
  projectEventSubjectReference,
  type ProjectEventQuestionSubject
} from '../../shared/forge-inbox-project-event-question'
import { clampUtf8TextPrefix as truncateProjectEventUtf8 } from '../../shared/utf8-byte-limits'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { PROJECT_ITEM_IID } from './forge-inbox-project-event-subject'
import { rowText } from './forge-inbox-rows'

const MAX_TITLE_BYTES = 512
const KIND_PATTERN = /^[a-z_]{1,40}$/

export { truncateProjectEventUtf8 }

/** Control characters would break the one-line template, so they are dropped, not escaped. */
function singleLine(text: string): string {
  let kept = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) {
      kept += character
    }
  }
  return kept
}

/**
 * The reported title is untrusted event text: it stays one bounded line, and a client renders the
 * sentence around it in its own locale.
 */
export function projectEventQuestionSubject(
  facts: Record<string, unknown>
): ProjectEventQuestionSubject | null {
  const kind = typeof facts.kind === 'string' ? facts.kind : ''
  const iid = typeof facts.iid === 'number' ? facts.iid : 0
  const rawTitle = typeof facts.title === 'string' ? facts.title : ''
  const named = kind === 'project' ? iid === PROJECT_ITEM_IID : iid > 0
  if (!KIND_PATTERN.test(kind) || !Number.isSafeInteger(iid) || !named) {
    return null
  }
  return { kind, iid, title: truncateProjectEventUtf8(singleLine(rawTitle), MAX_TITLE_BYTES) }
}

/** The host's own copy, kept as the stored fallback for readers that predate the subject. */
export function projectEventQuestionText(subject: ProjectEventQuestionSubject): string {
  const { kind, iid, title } = subject
  if (kind === 'project') {
    return '需要你确认：项目中的最新事件是否要继续处理？'
  }
  const reference = `${kind} ${projectEventSubjectReference(kind, iid)}`
  return title.length === 0
    ? `需要你确认：${reference} 中的变更是否要继续处理？`
    : `需要你确认：${reference}「${title}」中的变更是否要继续处理？`
}

export type ProjectEventQuestionRound = 'ask' | 'reuse-open' | 'exhausted'

/** One answered round per delivery: the re-decision after an answer may not open a second one. */
export function projectEventQuestionRound(
  ctx: ForgeLedgerContext,
  deliveryId: number
): ProjectEventQuestionRound {
  const rows = ctx.db
    .prepare('SELECT status FROM project_event_questions WHERE host_id = ? AND delivery_id = ?')
    .all(ctx.hostId, deliveryId)
  const statuses = rows.map((row) => rowText(row, 'status'))
  if (statuses.includes('answered')) {
    return 'exhausted'
  }
  return statuses.includes('open') ? 'reuse-open' : 'ask'
}
