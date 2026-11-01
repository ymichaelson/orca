import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { answerProjectEventQuestion } from '@/runtime/project-event-client'
import {
  FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES,
  type ProjectEventQuestionView
} from '../../../../shared/forge-inbox-project-event-question'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { forgeQuestionCopy } from './forge-inbox-question-copy'

function answerBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The owner parks the delivery until a person answers; the answer only informs the next decision and
 * can never rewrite the project rules. A policy question offers its two choices instead of free text.
 */
export function ForgeInboxQuestionPanel({
  ownerHostId,
  ownerTarget,
  questions,
  onAnswered
}: {
  ownerHostId: string | null
  ownerTarget: RuntimeClientTarget
  questions: ProjectEventQuestionView[]
  onAnswered: () => void
}): React.JSX.Element | null {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [sendingId, setSendingId] = useState<number | null>(null)
  const [errorId, setErrorId] = useState<number | null>(null)
  if (questions.length === 0) {
    return null
  }

  const send = async (question: ProjectEventQuestionView, text: string): Promise<void> => {
    if (ownerHostId === null || sendingId !== null) {
      return
    }
    const answer = text.trim()
    if (answer.length === 0 || answerBytes(answer) > FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES) {
      return
    }
    setSendingId(question.id)
    setErrorId(null)
    try {
      const result = await answerProjectEventQuestion(ownerHostId, question.id, answer, ownerTarget)
      if (!result.ok) {
        setErrorId(question.id)
        return
      }
      setDrafts((current) => ({ ...current, [question.id]: '' }))
      onAnswered()
    } catch {
      setErrorId(question.id)
    } finally {
      setSendingId(null)
    }
  }

  return (
    <section className="mt-5">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate(
          'auto.components.forge-inbox.ForgeInboxQuestionPanel.title',
          'Needs your answer'
        )}
      </h3>
      <ul className="mt-2 flex flex-col gap-3">
        {questions.map((question) => {
          const busy = sendingId === question.id
          return (
            <li key={question.id} className="rounded-md border border-border px-3 py-2">
              <p className="text-xs leading-5 text-foreground/85">{forgeQuestionCopy(question)}</p>
              {question.source === 'policy' ? (
                <div className="mt-2">
                  <ButtonGroup>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || ownerHostId === null}
                      onClick={() => void send(question, 'enable')}
                    >
                      {translate(
                        'auto.components.forge-inbox.ForgeInboxQuestionPanel.policyEnable',
                        'Turn on'
                      )}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || ownerHostId === null}
                      onClick={() => void send(question, 'decline')}
                    >
                      {translate(
                        'auto.components.forge-inbox.ForgeInboxQuestionPanel.policyDecline',
                        'Not now'
                      )}
                    </Button>
                  </ButtonGroup>
                </div>
              ) : (
                <FreeTextAnswer
                  draft={drafts[question.id] ?? ''}
                  busy={busy}
                  ownerHostId={ownerHostId}
                  onDraftChange={(value) =>
                    setDrafts((current) => ({ ...current, [question.id]: value }))
                  }
                  onSend={() => void send(question, drafts[question.id] ?? '')}
                />
              )}
              {errorId === question.id ? (
                <span className="mt-2 block text-2xs text-destructive">
                  {translate(
                    'auto.components.forge-inbox.ForgeInboxQuestionPanel.sendFailed',
                    'Could not send the answer. Retry; your text is still here.'
                  )}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FreeTextAnswer({
  draft,
  busy,
  ownerHostId,
  onDraftChange,
  onSend
}: {
  draft: string
  busy: boolean
  ownerHostId: string | null
  onDraftChange: (value: string) => void
  onSend: () => void
}): React.JSX.Element {
  const tooLong = answerBytes(draft.trim()) > FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES
  return (
    <>
      <Textarea
        className="mt-2 min-h-16"
        value={draft}
        placeholder={translate(
          'auto.components.forge-inbox.ForgeInboxQuestionPanel.answerPlaceholder',
          'Your answer'
        )}
        disabled={busy || ownerHostId === null}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || tooLong || draft.trim().length === 0 || ownerHostId === null}
          onClick={onSend}
        >
          {translate('auto.components.forge-inbox.ForgeInboxQuestionPanel.send', 'Send answer')}
        </Button>
        {tooLong ? (
          <span className="text-2xs text-destructive">
            {translate(
              'auto.components.forge-inbox.ForgeInboxQuestionPanel.tooLong',
              'The answer is too long.'
            )}
          </span>
        ) : null}
      </div>
    </>
  )
}
