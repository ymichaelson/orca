// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProjectEventActivityEntry,
  ProjectEventActivityView
} from '../../../../shared/forge-inbox-project-event-activity'
import type { ProjectEventBindingView } from '../../../../shared/forge-inbox-project-binding'
import { ProjectEventBindingPanel } from './ProjectEventBindingPanel'

vi.mock('@/runtime/project-event-client', () => ({
  retryProjectEvent: vi.fn(),
  rotateProjectEventSecret: vi.fn()
}))

const BINDING: ProjectEventBindingView = {
  bindingId: 'binding-1',
  projectPath: 'group/demo',
  gitlabHost: 'gitlab.test',
  gitlabPath: 'group/demo',
  gitlabProjectId: 7,
  callbackUrl: 'https://orca.example.com/webhooks/gitlab/binding-1',
  hookId: 12,
  state: 'connected',
  failure: null,
  secretProtection: 'sealed',
  rejectedEvents: [],
  rotationPending: false,
  createdAt: 0,
  updatedAt: 0
}

function entry(overrides: Partial<ProjectEventActivityEntry> = {}): ProjectEventActivityEntry {
  return {
    id: 1,
    kind: 'merge_request',
    iid: 7,
    title: 'Add thing',
    occurredAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    outcome: 'done',
    errorCode: null,
    ...overrides
  }
}

describe('ProjectEventBindingPanel activity', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  function render(activity: ProjectEventActivityView): void {
    act(() =>
      root.render(
        <ProjectEventBindingPanel
          ownerHostId="owner"
          repoId="repo"
          target={{ kind: 'environment', environmentId: 'server-a' }}
          binding={BINDING}
          activity={activity}
          saving={false}
          refreshStatus={async () => {}}
        />
      )
    )
  }

  function lastProcessedText(lastProcessed: ProjectEventActivityEntry): string {
    render({ events: [], lastProcessed })
    const line = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.startsWith('Last delivery that finished')
    )
    return line?.textContent ?? ''
  }

  it('dates the last finished delivery by its finish time, not its receipt', () => {
    const text = lastProcessedText(entry({ finishedAt: Date.now() }))

    expect(text).toContain('this minute')
    expect(text).not.toMatch(/day/)
    expect(text).not.toContain('received')
  })

  it('labels the receipt time honestly when an older host omits the finish time', () => {
    const text = lastProcessedText(entry())

    expect(text).toContain('received')
    expect(text).toMatch(/day/)
  })

  it('explains a failed delivery with a localized code instead of a raw one', () => {
    render({
      events: [entry({ outcome: 'failed', errorCode: 'workspace-ambiguous' })],
      lastProcessed: null
    })

    expect(container.querySelector('li')?.textContent).toContain('Add thing')
    expect(container.querySelector('li')?.textContent).toContain('More than one workspace matches')
    expect(container.textContent).not.toContain('workspace-ambiguous')
  })
})
