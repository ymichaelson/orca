import type { ForgeInboxArchiveView } from '../../../../shared/forge-inbox-display-preferences'
import type { ForgeItemHandlingState } from '../../../../shared/forge-inbox-item-handling'
import type { ForgeItemKind } from '../../../../shared/forge-inbox-types'

/** The view is already clamped to `active` for a host that cannot archive. */
export function listFilter(
  unreadOnly: boolean,
  view: ForgeInboxArchiveView,
  projectId: string | null,
  kind: ForgeItemKind | null,
  handling: ForgeItemHandlingState | null
) {
  // Why: `active` is the server default, so asking for it explicitly only makes the probe refetch.
  return {
    ...(view === 'active' ? { unreadOnly } : { unreadOnly, archiveView: view }),
    ...(projectId === null ? {} : { projectId }),
    ...(kind === null ? {} : { kind }),
    ...(handling === null ? {} : { handling })
  }
}
