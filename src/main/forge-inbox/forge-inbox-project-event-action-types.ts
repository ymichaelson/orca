import type { ForgeNotificationReason } from '../../shared/forge-inbox-notification-subject'
import type { ProjectEventQuestionSubject } from '../../shared/forge-inbox-project-event-question'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import type {
  ProjectEventSubject,
  ProjectEventSubjectRefusal
} from './forge-inbox-project-event-subject'

/** A question reaches settle with both the host's stored copy and the facts a client localizes. */
export type ProjectEventQuestionPrompt = {
  text: string
  subject: ProjectEventQuestionSubject
}

export type ProjectEventActionClaim = {
  decisionId: number
  deliveryId: number
  action: ProjectEventDecisionAction
  itemId: number | null
  token: string
  startedAt: number
  bindingId: string
  repoId: string
  generation: number
}

export type ProjectEventActionOutcome =
  | { kind: 'done'; runId?: number }
  | { kind: 'queued' }
  | { kind: 'awaiting-event'; waitReason: string }
  /** The delivery waits for a person; question text reaches settle as its own argument, never here. */
  | { kind: 'awaiting-user' }
  | { kind: 'blocked'; code: string }

export type ProjectEventActionSettleResult =
  | { ok: true; actionState: 'done' | 'awaiting-event' | 'blocked' | 'queued' }
  | { ok: false; reason: 'not-found' }

export type ProjectEventActionItemLinkResult =
  | {
      ok: true
      itemId: number
      subject: ProjectEventSubject
      /** Reported facts an action may branch on; never the raw body. */
      facts: Record<string, unknown>
      /** Present only for notify: null when the facts prove no category. */
      notificationCategory?: ForgeNotificationReason | null
    }
  | { ok: false; reason: ProjectEventSubjectRefusal | 'not-found' | 'dispatch-unverifiable' }
