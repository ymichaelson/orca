import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  FORGE_INBOX_ARCHIVE_VIEW_VALUES,
  type ForgeInboxArchiveView
} from '../../../../shared/forge-inbox-display-preferences'
import {
  FORGE_ITEM_HANDLING_STATES,
  type ForgeItemHandlingState
} from '../../../../shared/forge-inbox-item-handling'
import { FORGE_ITEM_KINDS, type ForgeItemKind } from '../../../../shared/forge-inbox-types'
import { archiveViewLabel } from './forge-inbox-archive-view-copy'
import { forgeItemHandlingLabel, forgeItemKindLabel } from './forge-inbox-display'

/** Radix refuses an empty item value; `*` is not a project path, a kind or a handling state. */
const ANY = '*'

export function ForgeInboxListToolbar({
  unreadOnly,
  archiveView,
  archiveSupported,
  projectFilter,
  kindFilter,
  handlingFilter,
  projects,
  loading,
  onToggleUnreadOnly,
  onArchiveViewChange,
  onProjectFilterChange,
  onKindFilterChange,
  onHandlingFilterChange,
  onRetry
}: {
  unreadOnly: boolean
  archiveView: ForgeInboxArchiveView
  archiveSupported: boolean | null
  projectFilter: string | null
  kindFilter: ForgeItemKind | null
  handlingFilter: ForgeItemHandlingState | null
  projects: string[]
  loading: boolean
  onToggleUnreadOnly: () => void
  onArchiveViewChange: (view: ForgeInboxArchiveView) => void
  onProjectFilterChange: (projectId: string | null) => void
  onKindFilterChange: (kind: ForgeItemKind | null) => void
  onHandlingFilterChange: (handling: ForgeItemHandlingState | null) => void
  onRetry: () => void
}): React.JSX.Element {
  const projectValue = projectFilter ?? ANY
  const kindValue = kindFilter ?? ANY
  const handlingValue = handlingFilter ?? ANY
  return (
    <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant={unreadOnly ? 'secondary' : 'ghost'}
          aria-pressed={unreadOnly}
          onClick={onToggleUnreadOnly}
        >
          {translate('auto.components.forge-inbox.ForgeInboxList.unreadOnly', 'Unread only')}
        </Button>
        {archiveSupported === true ? (
          <ButtonGroup
            aria-label={translate(
              'auto.components.forge-inbox.ForgeInboxList.archiveView',
              'Archive view'
            )}
          >
            {FORGE_INBOX_ARCHIVE_VIEW_VALUES.map((view) => (
              <Button
                key={view}
                size="xs"
                variant={archiveView === view ? 'secondary' : 'outline'}
                aria-pressed={archiveView === view}
                onClick={() => onArchiveViewChange(view)}
              >
                {archiveViewLabel(view)}
              </Button>
            ))}
          </ButtonGroup>
        ) : null}
        <Button size="xs" variant="ghost" className="ml-auto" disabled={loading} onClick={onRetry}>
          {translate('auto.components.forge-inbox.ForgeInboxList.refresh', 'Refresh')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={kindValue}
          onValueChange={(value) =>
            onKindFilterChange(FORGE_ITEM_KINDS.find((kind) => kind === value) ?? null)
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={translate('auto.components.forge-inbox.ForgeInboxList.kindFilter', 'Kind')}
            className="min-w-0 flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>
              {translate('auto.components.forge-inbox.ForgeInboxList.allKinds', 'All kinds')}
            </SelectItem>
            {FORGE_ITEM_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {forgeItemKindLabel(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Why: an older host cannot name its projects, so the control would filter nothing. */}
        {projects.length > 0 ? (
          <Select
            value={projectValue}
            onValueChange={(value) => onProjectFilterChange(value === ANY ? null : value)}
          >
            <SelectTrigger
              size="sm"
              aria-label={translate(
                'auto.components.forge-inbox.ForgeInboxList.projectFilter',
                'Project'
              )}
              className="min-w-0 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>
                {translate(
                  'auto.components.forge-inbox.ForgeInboxList.allProjects',
                  'All projects'
                )}
              </SelectItem>
              {projects.map((project) => (
                <SelectItem key={project} value={project}>
                  {project}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <Select
        value={handlingValue}
        onValueChange={(value) =>
          onHandlingFilterChange(
            FORGE_ITEM_HANDLING_STATES.find((state) => state === value) ?? null
          )
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={translate(
            'auto.components.forge-inbox.ForgeInboxList.handlingFilter',
            'Status'
          )}
          className="min-w-0 flex-1"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>
            {translate('auto.components.forge-inbox.ForgeInboxList.allHandling', 'Any status')}
          </SelectItem>
          {FORGE_ITEM_HANDLING_STATES.map((state) => (
            <SelectItem key={state} value={state}>
              {forgeItemHandlingLabel(state)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {archiveSupported === false ? (
        <p className="text-2xs text-muted-foreground">
          {translate(
            'auto.components.forge-inbox.ForgeInboxList.archiveUnavailable',
            'This host is older and cannot archive items. Update it to archive.'
          )}
        </p>
      ) : null}
    </div>
  )
}
