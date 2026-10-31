import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  ForgeInboxEventsPage,
  ForgeInboxItemDetail,
  ForgeInboxItemMergeOutcome,
  ForgeInboxItemsPage,
  ForgeInboxProjectsView,
  ForgeInboxRunsPage,
  ForgeInboxStatus
} from '../../../shared/forge-inbox-rpc-types'
import type { ForgeItemHandlingState } from '../../../shared/forge-inbox-item-handling'
import type { ForgeItemKind } from '../../../shared/forge-inbox-types'
import type { ForgeInboxArchiveView } from '../../../shared/forge-inbox-display-preferences'
import { callRuntimeRpc } from './runtime-rpc-client'

/** The inbox belongs to the host this window is attached to; in the web client that is the server. */
const HOST_RUNTIME: RuntimeClientTarget = { kind: 'local' }

export function readForgeInboxStatus(
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxStatus> {
  return callRuntimeRpc<ForgeInboxStatus>(target, 'forgeInbox.getStatus')
}

/** Unlike a status read, this reconciles the listener socket against the persisted settings. */
export function retryForgeInboxReceiver(
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxStatus> {
  return callRuntimeRpc<ForgeInboxStatus>(target, 'forgeInbox.retryReceiver')
}

/** Reads are owner-qualified: the host id comes from `getStatus`, never from a workspace. */
export function listForgeInboxItems(
  ownerHostId: string,
  query: {
    instanceId?: string
    unreadOnly?: boolean
    archiveView?: ForgeInboxArchiveView
    projectId?: string
    kind?: ForgeItemKind
    handling?: ForgeItemHandlingState
    limit?: number
    cursor?: number
  } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxItemsPage> {
  return callRuntimeRpc<ForgeInboxItemsPage>(target, 'forgeInbox.listItems', {
    ownerHostId,
    ...query
  })
}

/** A host older than this method answers with an error; the caller offers no project filter then. */
export function listForgeInboxProjects(
  ownerHostId: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxProjectsView> {
  return callRuntimeRpc<ForgeInboxProjectsView>(target, 'forgeInbox.listProjects', { ownerHostId })
}

export function readForgeInboxItemDetail(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxItemDetail> {
  return callRuntimeRpc<ForgeInboxItemDetail>(target, 'forgeInbox.getItemDetail', {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

export function listForgeInboxRuns(
  ownerHostId: string,
  query: { instanceId?: string; itemId?: number; limit?: number; cursor?: number } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxRunsPage> {
  return callRuntimeRpc<ForgeInboxRunsPage>(target, 'forgeInbox.listRuns', {
    ownerHostId,
    ...query
  })
}

export function listForgeInboxEvents(
  ownerHostId: string,
  itemId: number,
  query: { instanceId?: string; limit?: number; cursor?: number } = {},
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxEventsPage> {
  return callRuntimeRpc<ForgeInboxEventsPage>(target, 'forgeInbox.listEvents', {
    ownerHostId,
    itemId,
    ...query
  })
}

export function markForgeInboxItemRead(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<{ ownerHostId: string; marked: boolean }> {
  return callRuntimeRpc<{ ownerHostId: string; marked: boolean }>(target, 'forgeInbox.markRead', {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

function archiveCall(
  method: 'forgeInbox.archiveItem' | 'forgeInbox.unarchiveItem',
  ownerHostId: string,
  itemId: number,
  instanceId: string | undefined,
  target: RuntimeClientTarget
): Promise<{ ownerHostId: string; applied: boolean }> {
  return callRuntimeRpc<{ ownerHostId: string; applied: boolean }>(target, method, {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}

/** Only call this against a host advertising the item-archive capability; an older host rejects it. */
export function archiveForgeInboxItem(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<{ ownerHostId: string; applied: boolean }> {
  return archiveCall('forgeInbox.archiveItem', ownerHostId, itemId, instanceId, target)
}

export function unarchiveForgeInboxItem(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<{ ownerHostId: string; applied: boolean }> {
  return archiveCall('forgeInbox.unarchiveItem', ownerHostId, itemId, instanceId, target)
}

/** Merges the exact head the latest run recommended; the host refuses anything else. */
export function mergeForgeInboxItem(
  ownerHostId: string,
  itemId: number,
  instanceId?: string,
  target: RuntimeClientTarget = HOST_RUNTIME
): Promise<ForgeInboxItemMergeOutcome> {
  return callRuntimeRpc<ForgeInboxItemMergeOutcome>(target, 'forgeInbox.mergeItem', {
    ownerHostId,
    itemId,
    ...(instanceId === undefined ? {} : { instanceId })
  })
}
