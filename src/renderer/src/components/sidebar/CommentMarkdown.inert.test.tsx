// @vitest-environment happy-dom

// Protected analysis text is untrusted: it must not fetch remote media, must not render raw HTML,
// and must not turn its links into anything that navigates before the reader names a destination.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const mocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('./CommentMermaidBlock', () => ({ default: mocks.mermaid }))

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(content: string, inertContent: boolean): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <CommentMarkdown variant="document" content={content} inertContent={inertContent} />
    )
  })
  return container
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  expect(mocks.mermaid).not.toHaveBeenCalled()
  mocks.mermaid.mockClear()
})

describe('CommentMarkdown inert content', () => {
  it('draws a markdown image as text instead of fetching it', () => {
    const container = render('Before ![the screenshot](https://example.test/x.png)', true)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('the screenshot')
  })

  it('drops raw HTML instead of rendering its elements', () => {
    const container = render(
      '<img src="https://example.test/raw.png" alt="raw"> <a href="https://example.test/raw">raw link</a>',
      true
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[src]')).toBeNull()
  })

  it('hands a link to the click handler without a destination of its own', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[the merge request](https://example.test/mr/1)"
          inertContent
          onLinkClick={onLinkClick}
        />
      )
    })

    expect(container.querySelector('a')).toBeNull()
    const link = container.querySelector('button')
    expect(link?.textContent).toBe('the merge request')
    act(() => link?.click())
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.test/mr/1')
  })

  it('leaves ordinary content rendering images and links as before', () => {
    const container = render(
      '[the merge request](https://example.test/mr/1) ![shot](https://example.test/x.png)',
      false
    )

    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/mr/1')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/x.png')
  })
})
