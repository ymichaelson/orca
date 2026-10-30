import { parseRoutableExecutionHostId } from '../../../../shared/execution-host'
import { isForgeInboxNotificationClickTarget } from '../../../../shared/forge-inbox-notification-subject'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'
import { useAppStore } from '../../store'

/** A banner click lands on the item its fixed copy described, on the host that raised it. */
export function registerForgeInboxNotificationIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenForgeInboxItem((click) => {
      if (!isForgeInboxNotificationClickTarget(click)) {
        return
      }
      const host = parseRoutableExecutionHostId(click.executionHostId)
      const target = host === null ? null : ipcOrRuntimeTargetForHostId(host.id)
      if (target === null) {
        // Why: a stale banner must not open the local owner's item with the same id.
        useAppStore.getState().openUnroutableInboxItem()
        return
      }
      useAppStore.getState().openInboxItem({ target, itemId: click.subject.itemId })
    })
  )
}
