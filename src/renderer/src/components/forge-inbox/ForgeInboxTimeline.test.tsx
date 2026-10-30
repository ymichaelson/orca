// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeItemTimelineEntry } from '../../../../shared/forge-inbox-item-timeline'
import { FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES } from '../../../../shared/forge-inbox-project-event-question'
import { ForgeInboxTimeline } from './ForgeInboxTimeline'

const STATES = ['queued', 'processing', 'blocked', 'awaiting-event', 'done', 'cancelled']

function decision(
  state: string,
  overrides: Partial<Extract<ForgeItemTimelineEntry, { kind: 'decision' }>> = {}
): ForgeItemTimelineEntry {
  return {
    kind: 'decision',
    id: `decision:${state}`,
    at: 1_700_000_000_000,
    action: 'notify',
    state,
    errorCode: null,
    ...overrides
  }
}

describe('ForgeInboxTimeline', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(entries: ForgeItemTimelineEntry[]): void {
    act(() =>
      root.render(
        <ForgeInboxTimeline ownerTarget={{ kind: 'local' }} entries={entries} runs={[]} />
      )
    )
  }

  it('gives every decision state its own label and never prints the raw token', () => {
    render(STATES.map((state) => decision(state)))

    const labels = [...container.querySelectorAll('li')].map((item) => item.textContent ?? '')
    expect(new Set(labels).size).toBe(STATES.length)
    expect(container.textContent).not.toMatch(/awaiting-event/)
  })

  it('marks a replaced decision and leaves a current one unmarked', () => {
    render([decision('done', { superseded: true, id: 'decision:old' }), decision('queued')])

    const items = [...container.querySelectorAll('li')]
    expect(items[0].textContent).toContain('Replaced')
    expect(items[1].textContent).not.toContain('Replaced')
  })

  it('renders a stored answer as inert text', () => {
    const hostile = '<img src=x onerror=alert(1)>\nsecond line'
    render([{ kind: 'answer', id: 'answer:1', at: 1, questionId: 1, answer: hostile }])

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('p')?.textContent).toBe(hostile)
  })

  it.each([
    ['ASCII', 'a'.repeat(2100), 'a'.repeat(2000)],
    ['CJK', '界'.repeat(2000), '界'.repeat(666)],
    ['partial emoji', `${'a'.repeat(1999)}😀`, 'a'.repeat(1999)],
    ['exact-fit emoji', `${'a'.repeat(1996)}😀TAIL`, `${'a'.repeat(1996)}😀`]
  ])('bounds a stored %s answer to whole UTF-8 characters', (_name, answer, expected) => {
    render([{ kind: 'answer', id: 'answer:1', at: 1, questionId: 1, answer }])

    const rendered = container.querySelector('p')?.textContent
    expect(rendered).toBeDefined()
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(
      FORGE_PROJECT_EVENT_ANSWER_MAX_BYTES
    )
    expect(rendered).toBe(expected)
  })

  it('shows localized text for an unknown decision error code', () => {
    render([decision('blocked', { errorCode: 'raw-backend-token' })])

    expect(container.textContent).not.toContain('raw-backend-token')
    expect(container.textContent).toContain('Something went wrong.')
  })

  it('localizes the event category and missing context parts', () => {
    render([
      {
        kind: 'event',
        id: 'event:1',
        at: 1,
        eventKind: 'Merge Request Hook',
        summary: {
          category: 'review-request',
          completeness: { complete: false, notes: false, ci: false }
        }
      }
    ])

    expect(container.textContent).toContain('Review request')
    expect(container.textContent).toContain('notes, CI')
    expect(container.textContent).not.toContain('review-request')
  })
})
