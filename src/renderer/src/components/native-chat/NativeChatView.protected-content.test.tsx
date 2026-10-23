// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import NativeChatView from './NativeChatView'

const feed = vi.hoisted(() => ({ protectedAnalysis: false }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./NativeChatSessionGate', () => ({ NativeChatSessionGate: () => null }))
vi.mock('./NativeChatResolvedView', () => ({ NativeChatResolvedView: () => null }))
vi.mock('./use-native-chat-status-entry', () => ({ useNativeChatStatusEntry: vi.fn() }))
vi.mock('./StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionProtectedAnalysis: () => feed.protectedAnalysis
}))
// The probe reads the real context, so it fails if the boundary sits below the transcript.
vi.mock('./NativeChatStructuredSession', async () => {
  const { createElement } = await import('react')
  const { useNativeChatProtectedContent } = await import('./NativeChatProtectedContent')
  return {
    NativeChatStructuredSession: () =>
      createElement(
        'div',
        { 'data-testid': 'transcript' },
        useNativeChatProtectedContent() ? 'protected' : 'ordinary'
      )
  }
})

afterEach(cleanup)

function renderStructured(): void {
  render(
    <NativeChatView
      mode="structured"
      tabId="structured-tab"
      sessionId="session"
      agent="codex"
      target={{ kind: 'local' }}
      isVisible
      isFocusedGroup
    />
  )
}

it('marks every surface of a protected transcript', () => {
  feed.protectedAnalysis = true
  renderStructured()
  expect(screen.getByTestId('transcript').textContent).toBe('protected')
})

it('leaves an ordinary transcript alone', () => {
  feed.protectedAnalysis = false
  renderStructured()
  expect(screen.getByTestId('transcript').textContent).toBe('ordinary')
})
