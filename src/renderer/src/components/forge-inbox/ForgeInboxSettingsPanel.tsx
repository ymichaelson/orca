import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { FORGE_INBOX_ARCHIVE_VIEW_VALUES } from '../../../../shared/forge-inbox-display-preferences'
import { ForgeInboxNotificationPreferences } from './ForgeInboxNotificationPreferences'
import { archiveViewLabel } from './forge-inbox-archive-view-copy'

const SECTION_LABEL_CLASS =
  'text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground'

/** Display, read and notification choices; connection and project rules are linked, not edited. */
export function ForgeInboxSettingsPanel({
  ownerHostId,
  archiveSupported,
  onClose,
  onOpenProjectSettings,
  onOpenReceiverSettings
}: {
  ownerHostId: string | null
  archiveSupported: boolean | null
  onClose: () => void
  onOpenProjectSettings?: () => void
  onOpenReceiverSettings?: () => void
}): React.JSX.Element {
  const unreadOnly = useAppStore((state) => state.forgeInboxUnreadOnly)
  const archiveView = useAppStore((state) => state.forgeInboxArchiveView)
  const compact = useAppStore((state) => state.forgeInboxCompact)
  const setUnreadOnly = useAppStore((state) => state.setForgeInboxUnreadOnly)
  const setArchiveView = useAppStore((state) => state.setForgeInboxArchiveView)
  const setCompact = useAppStore((state) => state.setForgeInboxCompact)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          {translate('auto.components.forge-inbox.settings.back', 'Back to inbox')}
        </Button>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex max-w-xl flex-col gap-6">
          {ownerHostId === null ? null : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.forge-inbox.settings.hostScope',
                'List and notification preferences are stored on this computer. Read and archive state is stored on host {{hostId}} for your reader.',
                { hostId: ownerHostId }
              )}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <h3 className={SECTION_LABEL_CLASS}>
              {translate('auto.components.forge-inbox.settings.connectionTitle', 'Connection')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.forge-inbox.settings.connectionHint',
                'The GitLab callback, the host credential and each project’s agent are set up in Settings.'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {onOpenReceiverSettings ? (
                <Button type="button" variant="outline" size="sm" onClick={onOpenReceiverSettings}>
                  {translate(
                    'webhook.settings.open',
                    'Configure receiver in Settings → Integrations → Webhook'
                  )}
                </Button>
              ) : null}
              {onOpenProjectSettings ? (
                <Button type="button" variant="outline" size="sm" onClick={onOpenProjectSettings}>
                  {translate(
                    'auto.components.forge-inbox.settings.openProject',
                    'Open project settings'
                  )}
                </Button>
              ) : null}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className={SECTION_LABEL_CLASS}>
              {translate('auto.components.forge-inbox.settings.displayTitle', 'List')}
            </h3>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="forge-inbox-unread-only">
                {translate('auto.components.forge-inbox.ForgeInboxList.unreadOnly', 'Unread only')}
              </Label>
              <Switch
                id="forge-inbox-unread-only"
                checked={unreadOnly}
                onCheckedChange={setUnreadOnly}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="forge-inbox-compact">
                {translate('auto.components.forge-inbox.settings.compact', 'Compact rows')}
              </Label>
              <Switch id="forge-inbox-compact" checked={compact} onCheckedChange={setCompact} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label>
                {translate(
                  'auto.components.forge-inbox.ForgeInboxList.archiveView',
                  'Archive view'
                )}
              </Label>
              {archiveSupported === true ? (
                <ButtonGroup>
                  {FORGE_INBOX_ARCHIVE_VIEW_VALUES.map((view) => (
                    <Button
                      key={view}
                      type="button"
                      size="xs"
                      variant={archiveView === view ? 'secondary' : 'outline'}
                      aria-pressed={archiveView === view}
                      onClick={() => setArchiveView(view)}
                    >
                      {archiveViewLabel(view)}
                    </Button>
                  ))}
                </ButtonGroup>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {archiveSupported === false
                    ? translate(
                        'auto.components.forge-inbox.ForgeInboxList.archiveUnavailable',
                        'This host is older and cannot archive items. Update it to archive.'
                      )
                    : translate(
                        'auto.components.forge-inbox.ForgeInboxList.archiveChecking',
                        'Checking whether this host can archive items…'
                      )}
                </span>
              )}
            </div>
          </section>

          <ForgeInboxNotificationPreferences />
        </div>
      </div>
    </div>
  )
}
