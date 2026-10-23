import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../index'

describe('Forge Inbox item links', () => {
  beforeEach(() => {
    useAppStore.setState({ activeView: 'terminal', pendingInboxItem: null })
  })

  it('opens the Inbox page on the item a banner click named', () => {
    useAppStore.getState().openInboxItem({ ownerHostId: 'owner', itemId: 7 })

    const state = useAppStore.getState()
    expect(state.activeView).toBe('inbox')
    expect(state.previousViewBeforeInbox).toBe('terminal')
    expect(state.pendingInboxItem).toEqual({ ownerHostId: 'owner', itemId: 7 })

    state.clearPendingInboxItem()
    expect(useAppStore.getState().pendingInboxItem).toBeNull()
  })

  it('keeps the view the page came from when the Inbox is already open', () => {
    useAppStore.setState({ activeView: 'inbox', previousViewBeforeInbox: 'tasks' })

    useAppStore.getState().openInboxItem({ ownerHostId: 'owner', itemId: 8 })

    expect(useAppStore.getState().previousViewBeforeInbox).toBe('tasks')
  })
})
