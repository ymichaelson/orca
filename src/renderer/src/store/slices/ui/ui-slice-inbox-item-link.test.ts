import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { useAppStore } from '../../index'

const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-a' }

describe('Forge Inbox item links', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeView: 'terminal',
      pendingInboxItem: null,
      forgeInboxOwnerTarget: { kind: 'local' }
    })
  })

  it('opens the Inbox page on the item a banner click named', () => {
    useAppStore.getState().openInboxItem({ target: REMOTE, itemId: 7 })

    const state = useAppStore.getState()
    expect(state.activeView).toBe('inbox')
    expect(state.previousViewBeforeInbox).toBe('terminal')
    expect(state.pendingInboxItem).toEqual({ target: REMOTE, itemId: 7 })
    // The click also selects the owner, so the page browses the host that raised the banner.
    expect(state.forgeInboxOwnerTarget).toEqual(REMOTE)

    state.clearPendingInboxItem()
    expect(useAppStore.getState().pendingInboxItem).toBeNull()
    expect(useAppStore.getState().forgeInboxOwnerTarget).toEqual(REMOTE)
  })

  it('keeps the view the page came from when the Inbox is already open', () => {
    useAppStore.setState({ activeView: 'inbox', previousViewBeforeInbox: 'tasks' })

    useAppStore.getState().openInboxItem({ target: REMOTE, itemId: 8 })

    expect(useAppStore.getState().previousViewBeforeInbox).toBe('tasks')
  })

  it('clears the fail-closed route error on the next open', () => {
    useAppStore.getState().openUnroutableInboxItem()
    expect(useAppStore.getState().forgeInboxRouteError).toBe(true)

    useAppStore.getState().openInboxPage()

    expect(useAppStore.getState().forgeInboxRouteError).toBe(false)
  })

  it('clears the fail-closed route error when the Inbox closes', () => {
    useAppStore.getState().openUnroutableInboxItem()
    expect(useAppStore.getState().forgeInboxRouteError).toBe(true)

    useAppStore.getState().closeInboxPage()

    expect(useAppStore.getState().forgeInboxRouteError).toBe(false)
  })

  it('selecting an owner drops a pending banner click', () => {
    useAppStore.getState().openInboxItem({ target: REMOTE, itemId: 9 })
    const next: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-b' }

    useAppStore.getState().setForgeInboxOwnerTarget(next)

    const state = useAppStore.getState()
    // The pending click belongs to the owner it named, not to the owner now shown.
    expect(state.pendingInboxItem).toBeNull()
    expect(state.forgeInboxOwnerTarget).toEqual(next)
  })
})
