import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { ForgeEventSummary } from '../../../../shared/forge-inbox-types'
import type { ForgeItemTimelineEntry } from '../../../../shared/forge-inbox-item-timeline'
import { projectEventAnswerText } from '../../../../shared/forge-inbox-project-event-question'
import type { ForgeRunView } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  forgeDecisionActionLabel,
  forgeDecisionStateLabel,
  forgeDecisionStateVariant,
  forgeEventCategoryLabel,
  forgeMissingContextLabel,
  forgeRunReasonLabel,
  forgeTimelineKindLabel,
  formatForgeDateTime
} from './forge-inbox-display'
import { forgeDispatchConfirmationDisplay } from './forge-inbox-dispatch-confirmation-display'
import { forgeQuestionCopy } from './forge-inbox-question-copy'
import { ForgeInboxError, type ForgeInboxRepairActions } from './ForgeInboxError'
import { ForgeInboxRunCard } from './ForgeInboxRunCard'

const KIND_LABEL_CLASS = 'text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground'

function eventDescription(summary: ForgeEventSummary): string {
  const parts: string[] = []
  if (summary.category !== undefined) {
    parts.push(forgeEventCategoryLabel(summary.category))
  }
  if (summary.pipeline?.observed?.status !== undefined) {
    parts.push(
      translate(
        'auto.components.forge-inbox.ForgeInboxTimeline.pipelineStatus',
        'pipeline {{status}}',
        { status: summary.pipeline.observed.status }
      )
    )
  }
  const completeness = summary.completeness
  if (completeness !== undefined && !completeness.complete) {
    const missing = [
      completeness.notes === false ? forgeMissingContextLabel('notes') : null,
      completeness.diffs === false ? forgeMissingContextLabel('diffs') : null,
      completeness.ci === false ? forgeMissingContextLabel('ci') : null
    ].filter((part): part is string => part !== null)
    parts.push(
      translate(
        'auto.components.forge-inbox.ForgeInboxDetail.missingContext',
        'incomplete: {{missing}}',
        { missing: missing.join(', ') }
      )
    )
  }
  return parts.join(' · ')
}

/** Older runs fall off the loaded page, so their entry carries the confirmation badge itself. */
function TimelineRunSummary({
  entry
}: {
  entry: Extract<ForgeItemTimelineEntry, { kind: 'run' }>
}): React.JSX.Element | null {
  const confirmation = forgeDispatchConfirmationDisplay(entry)
  if (entry.reason === null && confirmation === null) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {entry.reason === null ? null : (
        <span className="text-2xs text-muted-foreground">{forgeRunReasonLabel(entry.reason)}</span>
      )}
      {confirmation === null ? null : (
        <Badge variant={confirmation.variant}>{confirmation.label}</Badge>
      )}
    </div>
  )
}

function EntryDetail({
  entry,
  run,
  ownerTarget,
  repairActions
}: {
  entry: ForgeItemTimelineEntry
  run: ForgeRunView | null
  ownerTarget: RuntimeClientTarget
  repairActions?: ForgeInboxRepairActions
}): React.JSX.Element | null {
  switch (entry.kind) {
    case 'event':
      return (
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-2xs text-foreground/80">{entry.eventKind}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {eventDescription(entry.summary)}
          </span>
        </div>
      )
    case 'decision':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{forgeDecisionActionLabel(entry.action)}</Badge>
          <Badge variant={forgeDecisionStateVariant(entry.state)}>
            {forgeDecisionStateLabel(entry.state)}
          </Badge>
          {entry.superseded === true ? (
            <span className="text-2xs text-muted-foreground">
              {translate('auto.components.forge-inbox.ForgeInboxTimeline.replaced', 'Replaced')}
            </span>
          ) : null}
          {entry.errorCode !== null ? (
            <ForgeInboxError
              code={entry.errorCode}
              source={entry.errorSource}
              repairActions={repairActions}
            />
          ) : null}
        </div>
      )
    case 'run':
      return run === null ? (
        <TimelineRunSummary entry={entry} />
      ) : (
        <ForgeInboxRunCard run={run} ownerTarget={ownerTarget} repairActions={repairActions} />
      )
    case 'question':
      return <p className="whitespace-pre-wrap text-foreground/85">{forgeQuestionCopy(entry)}</p>
    case 'answer':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {translate(
              'auto.components.forge-inbox.ForgeInboxTimeline.answerGiven',
              'You replied.'
            )}
          </span>
          {entry.answer ? (
            <p className="whitespace-pre-wrap break-words text-foreground/85">
              {projectEventAnswerText(entry.answer)}
            </p>
          ) : null}
        </div>
      )
  }
}

/** Newest first and already ordered by the host, so a client never re-sorts the item's history. */
export function ForgeInboxTimeline({
  entries,
  runs,
  ownerTarget,
  repairActions
}: {
  entries: ForgeItemTimelineEntry[]
  runs: ForgeRunView[]
  ownerTarget: RuntimeClientTarget
  repairActions?: ForgeInboxRepairActions
}): React.JSX.Element {
  if (entries.length === 0) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {translate('auto.components.forge-inbox.ForgeInboxTimeline.empty', 'No activity yet.')}
      </p>
    )
  }
  return (
    <ul className="mt-2 flex flex-col">
      {entries.map((entry) => {
        const run =
          entry.kind === 'run'
            ? (runs.find((candidate) => `run:${candidate.id}` === entry.id) ?? null)
            : null
        return (
          <li
            key={entry.id}
            className="flex flex-col gap-1 border-b border-border/60 py-2 text-xs last:border-b-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={KIND_LABEL_CLASS}>{forgeTimelineKindLabel(entry.kind)}</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {formatForgeDateTime(entry.at)}
              </span>
            </div>
            <EntryDetail
              entry={entry}
              run={run}
              ownerTarget={ownerTarget}
              repairActions={repairActions}
            />
          </li>
        )
      })}
    </ul>
  )
}
