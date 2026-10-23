// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { NativeChatProtectedContentBoundary } from './NativeChatProtectedContent'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'

const feed = vi.hoisted(() => ({ protectedAnalysis: false }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => {
    throw new Error('Chat image fixtures must not resolve editor file connections')
  }
}))
vi.mock('./StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionProtectedAnalysis: () => feed.protectedAnalysis
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const readFile = vi.fn().mockResolvedValue({
  content: 'AA==',
  isBinary: true,
  mimeType: 'image/png'
})

const RUNTIME_CONTEXT: RuntimeFileOperationArgs = {
  target: { kind: 'local' as const },
  worktreeId: 'wt-1',
  worktreePath: '/repo/wt-1',
  expectedExecutionHostId: 'local'
}

async function renderAttachments(
  blocks: Parameters<typeof NativeChatImageAttachments>[0]['blocks']
) {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <NativeChatProtectedContentBoundary sessionId="session-1" target={{ kind: 'local' }}>
        <NativeChatImageAttachments blocks={blocks} runtimeContext={RUNTIME_CONTEXT} />
      </NativeChatProtectedContentBoundary>
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root }
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:owner-1')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  readFile.mockClear()
  Object.assign(window, {
    api: {
      fs: {
        readFile
      }
    }
  })
})

afterEach(() => {
  resetLocalImageSrcStateForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('image references in a protected transcript', () => {
  it('draws a remote image as inert text instead of loading it', async () => {
    feed.protectedAnalysis = true
    const { container, root } = await renderAttachments([
      { type: 'image-ref', url: 'https://tracker.example/chart.png', alt: 'Chart' }
    ])

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[src*="tracker.example"]')).toBeNull()
    expect(container.textContent).toContain('Chart')
    root.unmount()
  })

  it('reads no local file the protected content names', async () => {
    feed.protectedAnalysis = true
    const { container, root } = await renderAttachments([
      { type: 'image-ref', path: '/repo/wt-1/secret-diagram.png' }
    ])

    expect(readFile).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
    root.unmount()
  })

  it('loads the same remote image in an ordinary transcript', async () => {
    feed.protectedAnalysis = false
    const { container, root } = await renderAttachments([
      { type: 'image-ref', url: 'https://tracker.example/chart.png', alt: 'Chart' }
    ])

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://tracker.example/chart.png'
    )
    root.unmount()
  })

  it('reads the same local path in an ordinary transcript', async () => {
    feed.protectedAnalysis = false
    const { container, root } = await renderAttachments([
      { type: 'image-ref', path: '/repo/wt-1/diagram.png' }
    ])

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:owner-1')
    root.unmount()
  })
})
