import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { NotificationSettingToggle } from '../settings/NotificationSettingToggle'

/** The same notification settings the Notifications pane edits, so one toggle never disagrees with another. */
export function ForgeInboxNotificationPreferences(): React.JSX.Element | null {
  const notifications = useAppStore((state) => state.settings?.notifications)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!notifications) {
    return null
  }
  const update = (updates: Partial<typeof notifications>): void => {
    void updateSettings({ notifications: { ...notifications, ...updates } })
  }
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('auto.components.forge-inbox.settings.notificationsTitle', 'Notifications')}
      </h3>
      <NotificationSettingToggle
        label={translate('auto.components.forge-inbox.settings.notifyInbox', 'Inbox attention')}
        description={translate(
          'auto.components.forge-inbox.settings.notifyInboxHint',
          'Tell me when an event needs me or a run fails. Stored with your other notification settings on this computer.'
        )}
        checked={notifications.forgeInbox}
        onToggle={() => update({ forgeInbox: !notifications.forgeInbox })}
      />
      <NotificationSettingToggle
        label={translate('auto.components.forge-inbox.settings.notifyCompleted', 'Completed runs')}
        description={translate(
          'auto.components.forge-inbox.settings.notifyCompletedHint',
          'Also tell me when a run finishes normally. Off by default; finished runs stay recorded here either way.'
        )}
        checked={notifications.forgeInboxCompletedRuns === true}
        disabled={!notifications.forgeInbox}
        onToggle={() =>
          update({ forgeInboxCompletedRuns: notifications.forgeInboxCompletedRuns !== true })
        }
      />
    </section>
  )
}
