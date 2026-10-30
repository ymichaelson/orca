import { FORGE_ITEM_KINDS } from '../../../../shared/forge-inbox-types'
import {
  projectEventSubjectReference,
  type ProjectEventQuestionSource,
  type ProjectEventQuestionSubject
} from '../../../../shared/forge-inbox-project-event-question'
import { translate } from '@/i18n/i18n'
import { forgeItemKindLabel } from './forge-inbox-display'

/** An unknown kind stays verbatim: the subject is untrusted event data, not a closed enum here. */
function subjectKindCopy(kind: string): string {
  const known = FORGE_ITEM_KINDS.find((candidate) => candidate === kind)
  return known === undefined ? kind : forgeItemKindLabel(known)
}

/**
 * A task's own question is shown as it was asked; the host's generic sentence is localized for the
 * reader, and the stored text is the fallback for a question without facts.
 */
export function forgeQuestionCopy(question: {
  question: string
  subject: ProjectEventQuestionSubject | null
  source?: ProjectEventQuestionSource | null
}): string {
  if (question.source === 'answer') {
    return question.question
  }
  const subject = question.subject
  if (subject === null) {
    return question.question
  }
  if (subject.kind === 'project') {
    return translate(
      'auto.components.forge-inbox.ForgeInboxQuestionPanel.questionProject',
      'Confirm whether the latest event in this project should still be handled.'
    )
  }
  const kind = subjectKindCopy(subject.kind)
  const reference = projectEventSubjectReference(subject.kind, subject.iid)
  if (subject.title.length === 0) {
    return translate(
      'auto.components.forge-inbox.ForgeInboxQuestionPanel.questionNoTitle',
      'Confirm whether the change in {{kind}} {{reference}} should still be handled.',
      { kind, reference }
    )
  }
  return translate(
    'auto.components.forge-inbox.ForgeInboxQuestionPanel.questionWithTitle',
    'Confirm whether the change in {{kind}} {{reference}} “{{title}}” should still be handled.',
    { kind, reference, title: subject.title }
  )
}
