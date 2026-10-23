import { isForgeInboxNotificationClickTarget } from '../../../../shared/forge-inbox-notification-subject'
import { useAppStore } from '../../store'

/** A banner click lands on the item its fixed copy described, in the Inbox page. */
export function registerForgeInboxNotificationIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenForgeInboxItem((target) => {
      if (!isForgeInboxNotificationClickTarget(target)) {
        return
      }
      useAppStore.getState().openInboxItem({
        ownerHostId: target.subject.ownerId,
        itemId: target.subject.itemId
      })
    })
  )
}
