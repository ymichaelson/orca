// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { GlobalHookDefaultsSetting } from './GlobalHookDefaultsSetting'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function renderGlobalHookDefaultsSetting(args: {
  settings?: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): void {
  act(() => {
    root.render(
      <GlobalHookDefaultsSetting
        settings={args.settings ?? getDefaultSettings('/tmp')}
        updateSettings={args.updateSettings}
      />
    )
  })
}

function getTextareas(): HTMLTextAreaElement[] {
  return Array.from(container.querySelectorAll('textarea'))
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setValue?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blur(textarea: HTMLTextAreaElement): void {
  act(() => {
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('GlobalHookDefaultsSetting', () => {
  it('renders empty setup and archive fields when no global defaults are set', () => {
    renderGlobalHookDefaultsSetting({ updateSettings: () => {} })

    const textareas = getTextareas()
    expect(textareas).toHaveLength(2)
    expect(textareas[0].value).toBe('')
    expect(textareas[1].value).toBe('')
  })

  it('renders saved global defaults', () => {
    renderGlobalHookDefaultsSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        globalHookDefaults: { setup: 'pnpm install', archive: 'pnpm run clean' }
      },
      updateSettings: () => {}
    })

    const textareas = getTextareas()
    expect(textareas[0].value).toBe('pnpm install')
    expect(textareas[1].value).toBe('pnpm run clean')
  })

  it('keeps typed scripts local until blur', () => {
    const updateSettings = vi.fn()
    renderGlobalHookDefaultsSetting({ updateSettings })

    const [setup] = getTextareas()
    typeInto(setup, 'pnpm install')

    expect(updateSettings).not.toHaveBeenCalled()

    blur(setup)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      globalHookDefaults: { setup: 'pnpm install', archive: '' }
    })
  })

  it('does not commit when the value is unchanged', () => {
    const updateSettings = vi.fn()
    renderGlobalHookDefaultsSetting({ updateSettings })

    const [setup] = getTextareas()
    blur(setup)

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('preserves the other field when committing one field', () => {
    const updateSettings = vi.fn()
    renderGlobalHookDefaultsSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        globalHookDefaults: { setup: 'pnpm install', archive: '' }
      },
      updateSettings
    })

    const [, archive] = getTextareas()
    typeInto(archive, 'pnpm run clean')
    blur(archive)

    expect(updateSettings).toHaveBeenCalledWith({
      globalHookDefaults: { setup: 'pnpm install', archive: 'pnpm run clean' }
    })
  })

  it('preserves a pending commit when both fields are edited before the settings prop updates', () => {
    const updateSettings = vi.fn()
    renderGlobalHookDefaultsSetting({ updateSettings })

    const [setup, archive] = getTextareas()
    typeInto(setup, 'pnpm install')
    blur(setup)
    // The settings prop has not updated yet (first write still pending);
    // committing the other field must not erase the first script.
    typeInto(archive, 'pnpm run clean')
    blur(archive)

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      globalHookDefaults: { setup: 'pnpm install', archive: '' }
    })
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      globalHookDefaults: { setup: 'pnpm install', archive: 'pnpm run clean' }
    })
  })

  it('explains the fallback applies only when the project has no script', () => {
    renderGlobalHookDefaultsSetting({ updateSettings: () => {} })

    expect(container.textContent).toContain(
      'Used only when a project has no local or shared script for that hook.'
    )
  })
})
