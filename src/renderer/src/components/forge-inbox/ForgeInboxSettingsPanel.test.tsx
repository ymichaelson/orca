// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../../../shared/notification-settings-defaults'

const state: { current: Record<string, unknown> } = vi.hoisted(() => ({ current: {} }))

vi.mock('@/store', () => ({
  useAppStore: (select: (value: Record<string, unknown>) => unknown) => select(state.current)
}))

import { ForgeInboxSettingsPanel } from './ForgeInboxSettingsPanel'

function control(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll('button')].find((item) =>
    (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(label)
  )
  if (!found) {
    throw new Error(`no control matching ${label}`)
  }
  return found
}

describe('ForgeInboxSettingsPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const actions = {
    openSettingsTarget: vi.fn(),
    setForgeInboxUnreadOnly: vi.fn(),
    setForgeInboxArchiveView: vi.fn(),
    setForgeInboxCompact: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue(undefined)
  }

  function render(props: Partial<Parameters<typeof ForgeInboxSettingsPanel>[0]> = {}): void {
    act(() =>
      root.render(
        <ForgeInboxSettingsPanel
          ownerHostId="owner-1"
          archiveSupported
          onClose={vi.fn()}
          {...props}
        />
      )
    )
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.values(actions).forEach((action) => action.mockClear())
    state.current = {
      ...actions,
      forgeInboxUnreadOnly: false,
      forgeInboxArchiveView: 'active',
      forgeInboxCompact: false,
      settings: { notifications: getDefaultNotificationSettings() }
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('distinguishes local display preferences from the paired owner', () => {
    render({ ownerHostId: 'remote-owner' })
    expect(container.textContent).toContain(
      'List and notification preferences are stored on this computer.'
    )
    expect(container.textContent).toContain('Read and archive state is stored on host remote-owner')
  })

  it('renders no GitLab instance or credential form', () => {
    render()

    expect(container.querySelectorAll('input[type="password"], input[type="url"]')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/Add GitLab instance|API token|Save settings/)
  })

  it('offers the receiver settings only when the owner can open them', () => {
    render()
    expect(container.textContent).not.toContain('Configure receiver')

    const openReceiver = vi.fn()
    render({ onOpenReceiverSettings: openReceiver })
    act(() => control(container, 'Configure receiver').click())
    expect(openReceiver).toHaveBeenCalledTimes(1)
    expect(actions.openSettingsTarget).not.toHaveBeenCalled()
  })

  it('only offers project settings when a project is linked', () => {
    render()
    expect(container.textContent).not.toContain('Open project settings')

    const openProject = vi.fn()
    render({ onOpenProjectSettings: openProject })
    act(() => control(container, 'Open project settings').click())
    expect(openProject).toHaveBeenCalledTimes(1)
  })

  it('saves the display choices through the persisted preference setters', () => {
    render()
    act(() => control(container, 'Archived').click())
    expect(actions.setForgeInboxArchiveView).toHaveBeenCalledWith('archived')

    const compact = container.querySelector<HTMLElement>('#forge-inbox-compact')
    if (!compact) {
      throw new Error('compact control not rendered')
    }
    act(() => compact.click())
    expect(actions.setForgeInboxCompact).toHaveBeenCalledWith(true)
  })

  it('explains an older host instead of offering the archive view', () => {
    render({ archiveSupported: false })
    expect(container.textContent).toContain('cannot archive items')
    expect(container.textContent).not.toContain('Archived')
  })

  it('does not describe unknown capabilities as an older host', () => {
    render({ archiveSupported: null })
    expect(container.textContent).not.toContain('This host is older')
  })

  it('edits the existing notification settings and keeps completed runs behind the master switch', () => {
    render()
    const completed = control(container, 'Completed runs')
    act(() => completed.click())
    expect(actions.updateSettings).toHaveBeenLastCalledWith({
      notifications: expect.objectContaining({ forgeInbox: true, forgeInboxCompletedRuns: true })
    })

    act(() => control(container, 'Inbox attention').click())
    expect(actions.updateSettings).toHaveBeenLastCalledWith({
      notifications: expect.objectContaining({ forgeInbox: false })
    })

    state.current = {
      ...state.current,
      settings: { notifications: { ...getDefaultNotificationSettings(), forgeInbox: false } }
    }
    render()
    expect(control(container, 'Completed runs').hasAttribute('disabled')).toBe(true)
  })
})
