import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import type { ForgeItemKind } from '../../../../shared/forge-inbox-types'
import type { ForgeInboxListItem } from '../../../../shared/forge-inbox-rpc-types'
import { forgeItemIdentityParts, formatForgeDateTime } from './forge-inbox-display'
import { forgeItemStatusTag } from './forge-inbox-item-status'
import { ForgeInboxListToolbar } from './ForgeInboxListToolbar'

function itemMeta(item: ForgeInboxListItem): string {
  const parts = [...forgeItemIdentityParts(item), formatForgeDateTime(item.updatedAt)]
  return parts.filter((part) => part.length > 0).join(' · ')
}

export function ForgeInboxList({
  items,
  selectedItemId,
  unreadOnly,
  archiveView,
  archiveSupported,
  projectFilter,
  kindFilter,
  handlingFilter,
  projects,
  compact,
  loading,
  loadingMore,
  hasMore,
  error,
  onSelect,
  onToggleUnreadOnly,
  onArchiveViewChange,
  onProjectFilterChange,
  onKindFilterChange,
  onHandlingFilterChange,
  onLoadMore,
  onRetry
}: {
  items: ForgeInboxListItem[]
  selectedItemId: number | null
  unreadOnly: boolean
  archiveView: ForgeInboxArchiveView
  archiveSupported: boolean | null
  projectFilter: string | null
  kindFilter: ForgeItemKind | null
  handlingFilter: ForgeItemHandlingState | null
  projects: string[]
  compact: boolean
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  onSelect: (itemId: number) => void
  onToggleUnreadOnly: () => void
  onArchiveViewChange: (view: ForgeInboxArchiveView) => void
  onProjectFilterChange: (projectId: string | null) => void
  onKindFilterChange: (kind: ForgeItemKind | null) => void
  onHandlingFilterChange: (handling: ForgeItemHandlingState | null) => void
  onLoadMore: () => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
      <ForgeInboxListToolbar
        unreadOnly={unreadOnly}
        archiveView={archiveView}
        archiveSupported={archiveSupported}
        projectFilter={projectFilter}
        kindFilter={kindFilter}
        handlingFilter={handlingFilter}
        projects={projects}
        loading={loading}
        onToggleUnreadOnly={onToggleUnreadOnly}
        onArchiveViewChange={onArchiveViewChange}
        onProjectFilterChange={onProjectFilterChange}
        onKindFilterChange={onKindFilterChange}
        onHandlingFilterChange={onHandlingFilterChange}
        onRetry={onRetry}
      />

      {error !== null ? (
        <div className="flex items-start gap-2 border-b border-border px-3 py-2">
          <p className="flex-1 text-xs text-destructive">{error}</p>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {translate('auto.components.forge-inbox.ForgeInboxList.retry', 'Retry')}
          </Button>
        </div>
      ) : null}

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {loading && items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {translate('auto.components.forge-inbox.ForgeInboxList.loading', 'Loading items…')}
          </p>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {archiveView === 'archived'
              ? translate(
                  'auto.components.forge-inbox.ForgeInboxList.emptyArchived',
                  'No archived items.'
                )
              : unreadOnly
                ? translate(
                    'auto.components.forge-inbox.ForgeInboxList.emptyUnread',
                    'No unread items.'
                  )
                : translate(
                    'auto.components.forge-inbox.ForgeInboxList.empty',
                    'No items yet. New project activity will appear here.'
                  )}
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              const selected = item.id === selectedItemId
              const statusTag = forgeItemStatusTag(item.handling, item.latestRunState ?? null)
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={selected ? 'true' : undefined}
                    data-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-border/60 px-3 text-left transition-colors',
                      compact ? 'py-1' : 'py-2',
                      selected ? 'bg-accent' : 'hover:bg-accent/60'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {item.unread ? (
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      ) : null}
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[13px] leading-5',
                          item.unread ? 'font-semibold text-foreground' : 'text-foreground/85'
                        )}
                      >
                        {item.title || forgeItemIdentityParts(item).slice(0, 2).join(' ')}
                      </span>
                    </span>
                    {statusTag === null && compact ? null : (
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        {statusTag === null ? null : (
                          <Badge variant={statusTag.variant}>{statusTag.label}</Badge>
                        )}
                        {compact ? null : (
                          <span className="truncate text-2xs text-muted-foreground">
                            {itemMeta(item)}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {hasMore ? (
          <div className="px-3 py-2">
            <Button
              size="xs"
              variant="outline"
              className="w-full"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore
                ? translate('auto.components.forge-inbox.ForgeInboxList.loadingMore', 'Loading…')
                : translate('auto.components.forge-inbox.ForgeInboxList.loadMore', 'Load more')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
