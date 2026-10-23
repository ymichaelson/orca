import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ForgeItem } from '../../../../shared/forge-inbox-types'
import { forgeItemKindLabel, formatForgeDateTime } from './forge-inbox-display'

function itemMeta(item: ForgeItem): string {
  const parts = [
    forgeItemKindLabel(item.kind),
    `#${item.iid}`,
    item.state,
    formatForgeDateTime(item.updatedAt)
  ]
  return parts.filter((part) => part.length > 0).join(' · ')
}

export function ForgeInboxList({
  items,
  selectedItemId,
  unreadOnly,
  loading,
  loadingMore,
  hasMore,
  error,
  onSelect,
  onToggleUnreadOnly,
  onLoadMore,
  onRetry
}: {
  items: ForgeItem[]
  selectedItemId: number | null
  unreadOnly: boolean
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  onSelect: (itemId: number) => void
  onToggleUnreadOnly: () => void
  onLoadMore: () => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          size="xs"
          variant={unreadOnly ? 'secondary' : 'ghost'}
          aria-pressed={unreadOnly}
          onClick={onToggleUnreadOnly}
        >
          {translate('auto.components.forge-inbox.ForgeInboxList.unreadOnly', 'Unread only')}
        </Button>
        <Button size="xs" variant="ghost" className="ml-auto" disabled={loading} onClick={onRetry}>
          {translate('auto.components.forge-inbox.ForgeInboxList.refresh', 'Refresh')}
        </Button>
      </div>

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
            {unreadOnly
              ? translate(
                  'auto.components.forge-inbox.ForgeInboxList.emptyUnread',
                  'No unread items.'
                )
              : translate(
                  'auto.components.forge-inbox.ForgeInboxList.empty',
                  'No items yet. New GitLab activity will appear here.'
                )}
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              const selected = item.id === selectedItemId
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={selected ? 'true' : undefined}
                    data-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-border/60 px-3 py-2 text-left transition-colors',
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
                        {item.title || `${forgeItemKindLabel(item.kind)} #${item.iid}`}
                      </span>
                    </span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {itemMeta(item)}
                    </span>
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
