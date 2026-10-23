import { useCallback, useEffect, useState } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ForgeInboxDetail } from './ForgeInboxDetail'
import { ForgeInboxList } from './ForgeInboxList'
import { ForgeInboxSettingsPanel } from './ForgeInboxSettingsPanel'
import { ForgeInboxStatusStrip } from './ForgeInboxStatusStrip'
import { useForgeInboxFeed } from './use-forge-inbox-feed'

export default function ForgeInboxPage(): React.JSX.Element {
  const closePage = useAppStore((state) => state.closeInboxPage)
  const pendingInboxItem = useAppStore((state) => state.pendingInboxItem)
  const clearPendingInboxItem = useAppStore((state) => state.clearPendingInboxItem)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const {
    status,
    statusError,
    items,
    itemsError,
    loadingStatus,
    loadingItems,
    loadingMore,
    hasMore,
    unreadOnly,
    selectedItemId,
    detail,
    events,
    detailError,
    loadingDetail,
    reload,
    loadMore,
    setUnreadOnly,
    selectItem
  } = useForgeInboxFeed()

  // Why: the settings draft lives inside the panel, which stays mounted so leaving it never discards edits.
  const handleDirtyChange = useCallback((dirty: boolean) => setSettingsDirty(dirty), [])

  // Why: a banner click opened this page for one item; select it once the owner is known, then drop the request.
  useEffect(() => {
    if (pendingInboxItem === null || status === null) {
      return
    }
    if (status.ownerHostId === pendingInboxItem.ownerHostId) {
      selectItem(pendingInboxItem.itemId)
    }
    clearPendingInboxItem()
  }, [pendingInboxItem, status, selectItem, clearPendingInboxItem])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (selectedItemId !== null) {
        selectItem(null)
        return
      }
      closePage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePage, selectItem, selectedItemId, settingsOpen])

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center gap-2 px-3 pb-3 md:px-5"
        // Why: no stacked center titlebar on this page; keep the title clear of Windows/Linux window controls.
        style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
      >
        <h1 className="truncate text-base font-semibold leading-8">
          {translate('auto.components.forge-inbox.ForgeInboxPage.title', 'Inbox')}
        </h1>
        {!settingsOpen && settingsDirty ? (
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.forge-inbox.settings.unsaved', 'Unsaved changes')}
          </span>
        ) : null}
        <Button
          type="button"
          variant={settingsOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="ml-auto"
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SettingsIcon className="size-4" />
          {translate('auto.components.forge-inbox.ForgeInboxPage.settings', 'Settings')}
        </Button>
      </header>

      <div className={settingsOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <ForgeInboxStatusStrip
          status={status}
          error={statusError}
          loading={loadingStatus}
          onRetry={reload}
        />

        <div className="flex min-h-0 flex-1">
          <ForgeInboxList
            items={items}
            selectedItemId={selectedItemId}
            unreadOnly={unreadOnly}
            loading={loadingItems}
            loadingMore={loadingMore}
            hasMore={hasMore}
            error={itemsError}
            onSelect={selectItem}
            onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
            onLoadMore={loadMore}
            onRetry={reload}
          />
          <ForgeInboxDetail
            ownerHostId={status?.ownerHostId ?? null}
            detail={detail}
            events={events}
            loading={loadingDetail}
            error={detailError}
            onChanged={reload}
          />
        </div>
      </div>

      <div className={settingsOpen ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ForgeInboxSettingsPanel
          onClose={() => setSettingsOpen(false)}
          onChanged={reload}
          onDirtyChange={handleDirtyChange}
        />
      </div>
    </main>
  )
}
