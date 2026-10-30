import type { ForgeDispatchConfirmationView } from './forge-inbox-dispatch-confirmation'
import type { ForgeInboxErrorSource } from './forge-inbox-error-source'
import type { ForgeEventSummary, ForgeRunState } from './forge-inbox-types'
import type { ProjectEventDecisionAction } from './project-event-decision'
import type {
  ProjectEventQuestionSource,
  ProjectEventQuestionSubject
} from './forge-inbox-project-event-question'

/**
 * One ordered stream per item: what arrived, what was decided, what ran and what the user replied.
 * Entries are already narrowed by host and item, so a client never infers handling from raw rows.
 */
export const FORGE_ITEM_TIMELINE_KINDS = ['event', 'decision', 'run', 'question', 'answer'] as const

export type ForgeItemTimelineKind = (typeof FORGE_ITEM_TIMELINE_KINDS)[number]

type TimelineEntryBase = { id: string; at: number }

export type ForgeItemTimelineEntry =
  | (TimelineEntryBase & {
      kind: 'event'
      eventKind: string
      summary: ForgeEventSummary
    })
  | (TimelineEntryBase & {
      kind: 'decision'
      action: ProjectEventDecisionAction
      state: string
      errorCode: string | null
      errorSource?: ForgeInboxErrorSource
      /** Optional so an older host's entry still parses; a replaced decision keeps its own state. */
      superseded?: boolean
    })
  | (TimelineEntryBase & {
      kind: 'run'
      state: ForgeRunState
      reason: string | null
      /** Optional so an older host's entry still parses; absent never means confirmed. */
      dispatchConfirmation?: ForgeDispatchConfirmationView
    })
  | (TimelineEntryBase & {
      kind: 'question'
      questionId: number
      /** The stored sentence; a host-written fallback, or the task's own question when it says so. */
      question: string
      subject: ProjectEventQuestionSubject | null
      /** Optional so an older host's entry still parses; absent reads as the host's own copy. */
      source?: ProjectEventQuestionSource
    })
  | (TimelineEntryBase & { kind: 'answer'; questionId: number; answer?: string })
