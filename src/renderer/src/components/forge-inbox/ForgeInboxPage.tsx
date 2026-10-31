import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import { forgeGenericErrorLabel } from './forge-inbox-error-code-copy'
import { ForgeInboxDetail } from './ForgeInboxDetail'
import { ForgeInboxList } from './ForgeInboxList'
import { ForgeInboxOwnerSelector } from './ForgeInboxOwnerSelector'
import { ForgeInboxSettingsPanel } from './ForgeInboxSettingsPanel'
import { ForgeInboxStatusStrip } from './ForgeInboxStatusStrip'
import { useForgeInboxFeed } from './use-forge-inbox-feed'

export default function ForgeInboxPage(): React.JSX.Element {
  const closePage = useAppStore((state) => state.closeInboxPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const repos = useAppStore((state) => state.repos)
  const pendingInboxItem = useAppStore((state) => state.pendingInboxItem)
  const clearPendingInboxItem = useAppStore((state) => state.clearPendingInboxItem)
  const ownerTarget = useAppStore((state) => state.forgeInboxOwnerTarget)
  const setOwnerTarget = useAppStore((state) => state.setForgeInboxOwnerTarget)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const routeError = useAppStore((state) => state.forgeInboxRouteError)
  const clearRouteError = useAppStore((state) => state.clearForgeInboxRouteError)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const compact = useAppStore((state) => state.forgeInboxCompact)
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
    archiveView,
    archiveSupported,
    projectFilter,
    kindFilter,
    handlingFilter,
    projects,
    selectedItemId,
    detail,
    questions,
    detailError,
    loadingDetail,
    reload,
    refreshStatus,
    loadMore,
    setUnreadOnly,
    setArchiveView,
    setProjectFilter,
    setKindFilter,
    setHandlingFilter,
    setItemArchived,
    selectItem
  } = useForgeInboxFeed(ownerTarget)
  // The repo catalog is this computer's, so only a repo on this computer gets a project-settings shortcut.
  const linkedRepos = detail?.repoId
    ? repos.filter((repo) => repo.id === detail.repoId && isRepoOnCatalogHost(repo))
    : []
  const linkedRepo = linkedRepos.length === 1 ? linkedRepos[0] : null

  // Why: a banner click opened this page for one item; select it once that target's owner answers, then drop the request.
  useEffect(() => {
    if (pendingInboxItem === null || status === null) {
      return
    }
    if (getRuntimeTargetHostId(pendingInboxItem.target) === getRuntimeTargetHostId(ownerTarget)) {
      selectItem(pendingInboxItem.itemId)
    }
    clearPendingInboxItem()
  }, [pendingInboxItem, status, ownerTarget, selectItem, clearPendingInboxItem])

  // Why: a run starting or finishing changes both the list's handling marks and the open item's runs.
  const activeRunKey =
    status !== null && status.phase !== 'unattached'
      ? (status.activeRuns ?? []).map((run) => run.runId).join(',')
      : null
  const lastActiveRunKey = useRef<string | null>(null)
  useEffect(() => {
    if (activeRunKey === null) {
      return
    }
    if (lastActiveRunKey.current === null) {
      lastActiveRunKey.current = activeRunKey
      return
    }
    if (lastActiveRunKey.current === activeRunKey) {
      return
    }
    lastActiveRunKey.current = activeRunKey
    reload()
  }, [activeRunKey, reload])

  const selectInboxItem = useCallback(
    (itemId: number | null) => {
      clearRouteError()
      selectItem(itemId)
    },
    [clearRouteError, selectItem]
  )

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

  const openLinkedProjectSettings = linkedRepo
    ? () =>
        openSettingsTarget({
          pane: 'repo',
          repoId: linkedRepo.id,
          hostId: 'local',
          hostScope: { kind: 'local' }
        })
    : undefined
  const openReceiverSettings = useCallback(
    () =>
      openSettingsTarget({
        pane: 'integrations',
        repoId: null,
        hostScope: { kind: 'local' },
        sectionId: 'integrations-webhook'
      }),
    [openSettingsTarget]
  )
  // Why: the receiver settings edit this computer's webhook pane, not a remote owner's.
  const receiverSettings = ownerTarget.kind === 'local' ? openReceiverSettings : undefined

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
        <ForgeInboxOwnerSelector
          target={ownerTarget}
          environments={runtimeEnvironments}
          onChange={setOwnerTarget}
        />
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

      {routeError ? (
        <div
          role="alert"
          className="border-b border-border px-3 py-2 text-xs text-destructive md:px-5"
        >
          {forgeGenericErrorLabel()}
        </div>
      ) : null}

      <div className={settingsOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <ForgeInboxStatusStrip
          status={status}
          error={statusError}
          loading={loadingStatus}
          onRetry={reload}
          onOpenReceiverSettings={receiverSettings}
          // Why: the settings pane covers this strip, so a hidden page must stop asking the host.
          onRefreshStatus={settingsOpen ? undefined : refreshStatus}
          onSelectActiveRun={selectInboxItem}
        />

        <div className="flex min-h-0 flex-1">
          <ForgeInboxList
            items={items}
            selectedItemId={selectedItemId}
            unreadOnly={unreadOnly}
            archiveView={archiveView}
            archiveSupported={archiveSupported}
            projectFilter={projectFilter}
            kindFilter={kindFilter}
            handlingFilter={handlingFilter}
            projects={projects}
            compact={compact}
            loading={loadingItems}
            loadingMore={loadingMore}
            hasMore={hasMore}
            error={itemsError}
            onSelect={selectInboxItem}
            onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
            onArchiveViewChange={setArchiveView}
            onProjectFilterChange={setProjectFilter}
            onKindFilterChange={setKindFilter}
            onHandlingFilterChange={setHandlingFilter}
            onLoadMore={loadMore}
            onRetry={reload}
          />
          <ForgeInboxDetail
            key={JSON.stringify([
              getRuntimeTargetHostId(ownerTarget),
              status?.ownerHostId ?? null,
              selectedItemId
            ])}
            ownerHostId={status?.ownerHostId ?? null}
            ownerTarget={ownerTarget}
            detail={detail}
            questions={questions}
            loading={loadingDetail}
            error={detailError}
            onChanged={reload}
            archiveSupported={archiveSupported === true}
            onSetArchived={setItemArchived}
            repairActions={{
              openHostSettings: openSettingsTarget,
              openProjectSettings: openLinkedProjectSettings
            }}
          />
        </div>
      </div>

      {settingsOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ForgeInboxSettingsPanel
            ownerHostId={status?.ownerHostId ?? null}
            archiveSupported={archiveSupported}
            onClose={() => setSettingsOpen(false)}
            onOpenProjectSettings={openLinkedProjectSettings}
            onOpenReceiverSettings={receiverSettings}
          />
        </div>
      ) : null}
    </main>
  )
}
