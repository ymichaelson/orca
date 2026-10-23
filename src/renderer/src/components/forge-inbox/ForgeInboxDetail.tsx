import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ForgeEvent, ForgeEventSummary } from '../../../../shared/forge-inbox-types'
import type {
  ForgeItemDetailView,
  ForgeProposalView
} from '../../../../shared/forge-inbox-rpc-types'
import {
  forgeItemKindLabel,
  forgeRunStateLabel,
  forgeRunStateVariant,
  formatForgeDateTime
} from './forge-inbox-display'
import { ForgeInboxProposalDialog } from './ForgeInboxProposalDialog'

const SECTION_LABEL_CLASS =
  'text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground'

function eventDescription(event: ForgeEvent): string {
  const summary: ForgeEventSummary = event.summary
  const parts: string[] = []
  if (summary.category !== undefined) {
    parts.push(summary.category)
  }
  if (summary.pipeline?.observed?.status !== undefined) {
    parts.push(`pipeline ${summary.pipeline.observed.status}`)
  }
  const completeness = summary.completeness
  if (completeness !== undefined && !completeness.complete) {
    const missing = [
      completeness.notes === false ? 'notes' : null,
      completeness.diffs === false ? 'diffs' : null,
      completeness.ci === false ? 'ci' : null
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

/** Model output is rendered as plain text on purpose: it must never become clickable HTML. */
export function ForgeInboxDetail({
  ownerHostId,
  detail,
  events,
  loading,
  error,
  onChanged
}: {
  ownerHostId: string | null
  detail: ForgeItemDetailView | null
  events: ForgeEvent[]
  loading: boolean
  error: string | null
  onChanged: () => void
}): React.JSX.Element {
  const [reviewing, setReviewing] = useState<ForgeProposalView | null>(null)
  if (error !== null) {
    return <p className="px-4 py-4 text-xs text-destructive">{error}</p>
  }
  if (loading && detail === null) {
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">
        {translate('auto.components.forge-inbox.ForgeInboxDetail.loading', 'Loading item…')}
      </p>
    )
  }
  if (detail === null) {
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">
        {translate(
          'auto.components.forge-inbox.ForgeInboxDetail.selectItem',
          'Select an item to see its analysis, runs and approvals.'
        )}
      </p>
    )
  }

  const { item, runs, proposals, revisions } = detail
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold leading-6 text-foreground">{item.title}</h2>
        <p className="text-xs text-muted-foreground">
          {forgeItemKindLabel(item.kind)} #{item.iid} · {item.state} ·{' '}
          {translate(
            'auto.components.forge-inbox.ForgeInboxDetail.project',
            'project {{projectId}}',
            { projectId: item.projectId }
          )}
        </p>
      </header>

      <section className="mt-5">
        <h3 className={SECTION_LABEL_CLASS}>
          {translate('auto.components.forge-inbox.ForgeInboxDetail.runs', 'Agent runs')}
        </h3>
        {runs.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {translate('auto.components.forge-inbox.ForgeInboxDetail.noRuns', 'No analysis yet.')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={forgeRunStateVariant(run.state)}>
                    {forgeRunStateLabel(run.state)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.forge-inbox.ForgeInboxDetail.revision',
                      'revision {{revision}}',
                      { revision: run.revision }
                    )}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {formatForgeDateTime(run.updatedAt)}
                  </span>
                  {run.reason !== null ? (
                    <span className="text-2xs text-muted-foreground">{run.reason}</span>
                  ) : null}
                  {run.errorCode !== null ? (
                    <span className="text-2xs text-destructive">{run.errorCode}</span>
                  ) : null}
                </div>
                {run.result !== null ? (
                  <div className="mt-2 flex flex-col gap-1">
                    <p className="whitespace-pre-wrap text-xs leading-5 text-foreground/85">
                      {run.result.summary}
                    </p>
                    {run.result.concerns.length > 0 ? (
                      <ul className="list-disc pl-4 text-xs leading-5 text-muted-foreground">
                        {run.result.concerns.map((concern) => (
                          <li key={`${run.id}:${concern}`} className="whitespace-pre-wrap">
                            {concern}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <h3 className={SECTION_LABEL_CLASS}>
          {translate('auto.components.forge-inbox.ForgeInboxDetail.events', 'Events')}
        </h3>
        {events.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {translate('auto.components.forge-inbox.ForgeInboxDetail.noEvents', 'No events yet.')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-2 border-b border-border/60 pb-1 text-xs"
              >
                <span className="font-mono text-2xs text-foreground/80">{event.eventKind}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {eventDescription(event)}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {formatForgeDateTime(event.receivedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <h3 className={SECTION_LABEL_CLASS}>
          {translate(
            'auto.components.forge-inbox.ForgeInboxDetail.approvals',
            'Approval proposals'
          )}
        </h3>
        {proposals.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.forge-inbox.ForgeInboxDetail.noProposals',
              'Nothing waiting for approval.'
            )}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-center gap-2 border-b border-border/60 py-1 text-xs"
              >
                <Badge variant={proposal.status === 'pending' ? 'dot' : 'outline'}>
                  {proposal.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {translate(
                    'auto.components.forge-inbox.ForgeInboxDetail.proposalRevision',
                    'revision {{revision}} · created {{createdAt}}',
                    {
                      revision: proposal.revision,
                      createdAt: formatForgeDateTime(proposal.createdAt)
                    }
                  )}
                </span>
                {proposal.status === 'pending' && ownerHostId !== null ? (
                  <Button size="xs" variant="outline" onClick={() => setReviewing(proposal)}>
                    {translate(
                      'auto.components.forge-inbox.ForgeInboxDetail.reviewProposal',
                      'Review'
                    )}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {revisions.length > 0 ? (
        <p className="mt-5 text-2xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxDetail.revisionCount',
            '{{count}} observed revisions · latest {{latest}}',
            {
              count: revisions.length,
              latest: formatForgeDateTime(revisions[0].createdAt)
            }
          )}
        </p>
      ) : null}

      {ownerHostId !== null ? (
        <ForgeInboxProposalDialog
          ownerHostId={ownerHostId}
          instanceId={item.instanceId}
          proposal={reviewing}
          onClose={() => setReviewing(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  )
}
