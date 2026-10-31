import type { ComponentProps } from 'react'
import type { Badge } from '@/components/ui/badge'
import type { ForgeItem, ForgeItemKind, ForgeRunState } from '../../../../shared/forge-inbox-types'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import { forgeItemStateLabel } from './forge-inbox-item-status'
import type { ForgeRunCancellationView } from '../../../../shared/forge-inbox-run-cancellation'
import type { ForgeItemTimelineKind } from '../../../../shared/forge-inbox-item-timeline'
import type { ProjectEventDecisionAction } from '../../../../shared/project-event-decision'
import type { ForgeInboxPhase } from '../../../../shared/forge-inbox-rpc-types'
import { translate } from '@/i18n/i18n'

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

export function formatForgeDateTime(value: number): string {
  return dateTimeFormatter.format(value)
}

export function forgeItemKindLabel(kind: ForgeItemKind): string {
  switch (kind) {
    case 'merge_request':
      return translate('auto.components.forge-inbox.display.kindMergeRequest', 'Merge request')
    case 'issue':
      return translate('auto.components.forge-inbox.display.kindIssue', 'Issue')
    case 'pipeline':
      return translate('auto.components.forge-inbox.display.kindPipeline', 'Pipeline')
    case 'project':
      return translate('auto.components.forge-inbox.display.kindProject', 'Project')
  }
}

/** A project item stands for the whole project, so it has no number or state of its own to show. */
export function forgeItemIdentityParts(item: Pick<ForgeItem, 'kind' | 'iid' | 'state'>): string[] {
  if (item.kind === 'project') {
    return [forgeItemKindLabel(item.kind)]
  }
  const state = forgeItemStateLabel(item.kind, item.state) ?? item.state
  return [forgeItemKindLabel(item.kind), `#${item.iid}`, state]
}

export function forgeRunStateLabel(
  state: ForgeRunState,
  cancellation?: ForgeRunCancellationView,
  /** A terminal dispatch whose process has not been seen to end is still running, whatever its state says. */
  terminalOpen = false
): string {
  if ((state === 'running' || terminalOpen) && cancellation !== undefined) {
    return cancellation.delivery === 'refused' || cancellation.delivery === 'unreachable'
      ? translate('auto.components.forge-inbox.display.runStopUnconfirmed', 'Stop not confirmed')
      : translate('auto.components.forge-inbox.display.runStopping', 'Stopping')
  }
  switch (state) {
    case 'queued':
      return translate('auto.components.forge-inbox.display.runQueued', 'Queued')
    case 'running':
      return translate('auto.components.forge-inbox.display.runRunning', 'Agent running')
    case 'awaiting-approval':
      return translate(
        'auto.components.forge-inbox.display.runAwaitingApproval',
        'Awaiting approval'
      )
    case 'succeeded':
      return translate('auto.components.forge-inbox.display.runSucceeded', 'Agent run succeeded')
    case 'failed':
      return translate('auto.components.forge-inbox.display.runFailed', 'Agent run failed')
    case 'cancelled':
      return translate('auto.components.forge-inbox.display.runCancelled', 'Cancelled')
    case 'unverifiable':
      return translate('auto.components.forge-inbox.display.runUnverifiable', 'Needs checking')
    case 'superseded':
      return translate('auto.components.forge-inbox.display.runSuperseded', 'Superseded')
  }
}

export function forgeTimelineKindLabel(kind: ForgeItemTimelineKind): string {
  switch (kind) {
    case 'event':
      return translate('auto.components.forge-inbox.display.timelineEvent', 'Event')
    case 'decision':
      return translate('auto.components.forge-inbox.display.timelineDecision', 'Decision')
    case 'run':
      return translate('auto.components.forge-inbox.display.timelineRun', 'Agent run')
    case 'question':
      return translate('auto.components.forge-inbox.display.timelineQuestion', 'Question')
    case 'answer':
      return translate('auto.components.forge-inbox.display.timelineAnswer', 'Answer')
  }
}

export function forgeDecisionActionLabel(action: ProjectEventDecisionAction): string {
  switch (action) {
    case 'record_only':
      return translate('auto.components.forge-inbox.display.actionRecordOnly', 'Record only')
    case 'notify':
      return translate('auto.components.forge-inbox.display.actionNotify', 'Notify')
    case 'wait':
      return translate('auto.components.forge-inbox.display.actionWait', 'Wait')
    case 'fetch_context':
      return translate('auto.components.forge-inbox.display.actionFetchContext', 'Fetch context')
    case 'dispatch_agent':
      return translate('auto.components.forge-inbox.display.actionDispatchAgent', 'Dispatch agent')
    case 'ask_user':
      return translate('auto.components.forge-inbox.display.actionAskUser', 'Ask you')
  }
}

export function forgeItemHandlingLabel(state: ForgeItemHandlingState, stopping = false): string {
  if (state === 'processing' && stopping) {
    return translate('auto.components.forge-inbox.display.runStopping', 'Stopping')
  }
  switch (state) {
    case 'recorded':
      return translate('auto.components.forge-inbox.display.handlingRecorded', 'Recorded')
    case 'processing':
      return translate('auto.components.forge-inbox.display.handlingProcessing', 'Processing')
    case 'waiting':
      return translate('auto.components.forge-inbox.display.handlingWaiting', 'Waiting for changes')
    case 'needs-user':
      return translate('auto.components.forge-inbox.display.handlingNeedsUser', 'Waiting for you')
    case 'done':
      return translate('auto.components.forge-inbox.display.handlingDone', 'Handled')
    case 'failed':
      return translate('auto.components.forge-inbox.display.handlingFailed', 'Handling failed')
    case 'unconfirmed':
      return translate(
        'auto.components.forge-inbox.display.handlingUnconfirmed',
        'Result unconfirmed'
      )
  }
}

export function forgeItemHandlingVariant(
  state: ForgeItemHandlingState
): ComponentProps<typeof Badge>['variant'] {
  if (state === 'needs-user') {
    return 'default'
  }
  if (state === 'failed') {
    return 'destructive'
  }
  if (state === 'done') {
    return 'secondary'
  }
  if (state === 'processing') {
    return 'dot'
  }
  return 'outline'
}

export function forgeRunStateVariant(
  state: ForgeRunState
): ComponentProps<typeof Badge>['variant'] {
  if (state === 'succeeded') {
    return 'secondary'
  }
  if (state === 'failed') {
    return 'destructive'
  }
  if (state === 'cancelled' || state === 'superseded') {
    return 'outline'
  }
  return 'dot'
}

export function forgePhaseLabel(phase: ForgeInboxPhase | 'unattached'): string {
  switch (phase) {
    case 'unattached':
      return translate('auto.components.forge-inbox.display.phaseUnattached', 'Not available')
    case 'new':
      return translate('auto.components.forge-inbox.display.phaseNew', 'Not started')
    case 'running':
      return translate('auto.components.forge-inbox.display.phaseRunning', 'Running')
    case 'stopped':
      return translate('auto.components.forge-inbox.display.phaseStopped', 'Stopped')
  }
}

/** A refused duplicate is a skip, not a failure: nothing is left for the reader to fix. */
const SKIPPED_ACTION_CODE = 'already-dispatched'

/** Decision states come from the host's CHECK list; an unlisted value falls back to a neutral label. */
export function forgeDecisionStateLabel(state: string, errorCode: string | null = null): string {
  if (state === 'blocked' && errorCode === SKIPPED_ACTION_CODE) {
    return translate('auto.components.forge-inbox.display.decisionSkipped', 'Skipped')
  }
  switch (state) {
    case 'queued':
      return translate('auto.components.forge-inbox.display.decisionQueued', 'Queued')
    case 'processing':
      return translate('auto.components.forge-inbox.display.decisionProcessing', 'Processing')
    case 'blocked':
      return translate('auto.components.forge-inbox.display.decisionBlocked', 'Blocked')
    case 'awaiting-event':
      return translate(
        'auto.components.forge-inbox.display.decisionAwaitingEvent',
        'Waiting for changes'
      )
    case 'done':
      return translate('auto.components.forge-inbox.display.decisionDone', 'Done')
    case 'cancelled':
      return translate('auto.components.forge-inbox.display.decisionCancelled', 'Cancelled')
    default:
      return translate('auto.components.forge-inbox.display.decisionUnknown', 'Status unknown')
  }
}

export function forgeDecisionStateVariant(
  state: string,
  errorCode: string | null = null
): ComponentProps<typeof Badge>['variant'] {
  if (state === 'blocked' && errorCode === SKIPPED_ACTION_CODE) {
    return 'outline'
  }
  if (state === 'done') {
    return 'secondary'
  }
  if (state === 'blocked') {
    return 'destructive'
  }
  if (state === 'queued' || state === 'processing') {
    return 'dot'
  }
  return 'outline'
}

export function forgeEventCategoryLabel(category: string): string {
  switch (category) {
    case 'review-request':
      return translate(
        'auto.components.forge-inbox.display.categoryReviewRequest',
        'Review request'
      )
    case 'participating-update':
      return translate(
        'auto.components.forge-inbox.display.categoryParticipatingUpdate',
        'Update on a thread you are in'
      )
    case 'pipeline-failure':
      return translate(
        'auto.components.forge-inbox.display.categoryPipelineFailure',
        'Pipeline failure'
      )
    case 'issue-mention':
      return translate('auto.components.forge-inbox.display.categoryIssueMention', 'Issue mention')
    case 'issue-assignment':
      return translate(
        'auto.components.forge-inbox.display.categoryIssueAssignment',
        'Issue assignment'
      )
    case 'project-event':
      return translate('auto.components.forge-inbox.display.categoryProjectEvent', 'Project event')
    default:
      return translate('auto.components.forge-inbox.display.categoryOther', 'Other')
  }
}

export function forgeMissingContextLabel(part: 'notes' | 'diffs' | 'ci'): string {
  switch (part) {
    case 'notes':
      return translate('auto.components.forge-inbox.display.contextNotes', 'notes')
    case 'diffs':
      return translate('auto.components.forge-inbox.display.contextDiffs', 'diffs')
    case 'ci':
      return translate('auto.components.forge-inbox.display.contextCi', 'CI')
  }
}

export function forgeRunReasonLabel(reason: string): string {
  return reason === 'project-event-dispatch'
    ? translate('auto.components.forge-inbox.display.reasonProjectEventDispatch', 'Project event')
    : forgeEventCategoryLabel(reason)
}
