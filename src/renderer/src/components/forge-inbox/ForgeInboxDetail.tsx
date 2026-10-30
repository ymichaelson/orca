import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { ProjectEventQuestionView } from '../../../../shared/forge-inbox-project-event-question'
import type { ForgeItemDetailView } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  forgeItemHandlingLabel,
  forgeItemHandlingVariant,
  forgeItemIdentityParts,
  formatForgeDateTime
} from './forge-inbox-display'
import { ForgeInboxError, type ForgeInboxRepairActions } from './ForgeInboxError'
import { ForgeInboxArchiveButton } from './ForgeInboxArchiveButton'
import { ForgeInboxQuestionPanel } from './ForgeInboxQuestionPanel'
import { ForgeInboxTimeline } from './ForgeInboxTimeline'

const SECTION_LABEL_CLASS =
  'text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground'

/** Model output is rendered as plain text on purpose: it must never become clickable HTML. */
export function ForgeInboxDetail({
  ownerHostId,
  ownerTarget,
  detail,
  questions,
  loading,
  error,
  onChanged,
  repairActions,
  archiveSupported = false,
  onSetArchived
}: {
  ownerHostId: string | null
  ownerTarget: RuntimeClientTarget
  detail: ForgeItemDetailView | null
  questions: ProjectEventQuestionView[]
  loading: boolean
  error: string | null
  onChanged: () => void
  repairActions?: ForgeInboxRepairActions
  archiveSupported?: boolean
  onSetArchived?: (itemId: number, archived: boolean) => Promise<boolean>
}): React.JSX.Element {
  if (error !== null) {
    return <p className="px-4 py-4 text-xs text-destructive">{error}</p>
  }
  if (loading) {
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
          'Select an item to see its activity, runs and questions.'
        )}
      </p>
    )
  }

  const { item, runs, proposals, revisions, handling, timeline } = detail
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold leading-6 text-foreground">
            {item.title}
          </h2>
          {archiveSupported && onSetArchived ? (
            <ForgeInboxArchiveButton
              itemId={item.id}
              archived={item.archived === true}
              onSetArchived={onSetArchived}
            />
          ) : null}
        </div>
        {handling !== undefined ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={forgeItemHandlingVariant(handling.state)}>
              {forgeItemHandlingLabel(handling.state, handling.stopping === true)}
            </Badge>
            {handling.errorCode !== null ? (
              <ForgeInboxError
                code={handling.errorCode}
                source={handling.errorSource}
                repairActions={repairActions}
              />
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {[
            ...forgeItemIdentityParts(item),
            translate(
              'auto.components.forge-inbox.ForgeInboxDetail.project',
              'project {{projectId}}',
              {
                projectId: item.projectId
              }
            )
          ].join(' · ')}
        </p>
      </header>

      <ForgeInboxQuestionPanel
        ownerHostId={ownerHostId}
        ownerTarget={ownerTarget}
        questions={questions}
        onAnswered={onChanged}
      />

      <section className="mt-5">
        <h3 className={SECTION_LABEL_CLASS}>
          {translate('auto.components.forge-inbox.ForgeInboxDetail.timeline', 'Timeline')}
        </h3>
        <ForgeInboxTimeline
          entries={
            timeline ??
            runs.map((run) => ({
              kind: 'run',
              id: `run:${run.id}`,
              at: run.updatedAt,
              state: run.state,
              reason: run.reason
            }))
          }
          runs={runs}
          ownerTarget={ownerTarget}
          repairActions={repairActions}
        />
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
    </div>
  )
}
