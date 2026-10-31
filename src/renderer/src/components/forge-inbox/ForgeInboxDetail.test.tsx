// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { ForgeInboxErrorSource } from '../../../../shared/forge-inbox-error-source'
import ForgeInboxPage from './ForgeInboxPage'

let pageDetail: ForgeItemDetailView | null = null
let repos: Repo[] = []
const navigate = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      repos,
      openSettingsTarget: navigate,
      closeInboxPage: () => {},
      pendingInboxItem: null,
      clearPendingInboxItem: () => {},
      forgeInboxOwnerTarget: { kind: 'local' },
      setForgeInboxOwnerTarget: () => {},
      runtimeEnvironments: [],
      forgeInboxRouteError: false,
      clearForgeInboxRouteError: () => {},
      forgeInboxCompact: false
    })
}))
vi.mock('./ForgeInboxSettingsPanel', () => ({ ForgeInboxSettingsPanel: () => null }))
vi.mock('./use-forge-inbox-feed', () => ({
  useForgeInboxFeed: () => ({
    status: null,
    statusError: null,
    items: [],
    itemsError: null,
    loadingStatus: false,
    loadingItems: false,
    loadingMore: false,
    hasMore: false,
    unreadOnly: false,
    archiveView: 'active',
    archiveSupported: false,
    projectFilter: null,
    kindFilter: null,
    handlingFilter: null,
    projects: [],
    selectedItemId: 1,
    detail: pageDetail,
    questions: [],
    detailError: null,
    loadingDetail: false,
    reload: () => {},
    loadMore: () => {},
    setUnreadOnly: () => {},
    setArchiveView: () => {},
    setProjectFilter: () => {},
    setKindFilter: () => {},
    setHandlingFilter: () => {},
    setItemArchived: async () => false,
    selectItem: () => {}
  })
}))
import type { ForgeItemDetailView, ForgeRunView } from '../../../../shared/forge-inbox-rpc-types'
import { ForgeInboxDetail } from './ForgeInboxDetail'

const RUN: ForgeRunView = {
  id: 12,
  itemId: 1,
  revision: 3,
  state: 'failed',
  generation: 1,
  policyGeneration: 1,
  contextDigest: 'digest',
  analysisKind: 'issue',
  reason: 'project-event-dispatch',
  errorCode: 'dispatch-unconfigured',
  sessionId: null,
  result: { summary: 'Actual legacy run result', concerns: [] },
  createdAt: 1,
  updatedAt: 2
}

function oldHostDetail(): Omit<ForgeItemDetailView, 'handling' | 'timeline'> {
  return {
    item: {
      id: 1,
      instanceId: 'gitlab:gitlab.test',
      projectId: 'group/demo',
      kind: 'issue',
      iid: 7,
      title: 'An observed issue',
      state: 'opened',
      currentRevision: 3,
      activitySeq: 1,
      unread: true,
      hostId: 'ledger-owner-uuid',
      createdAt: 1,
      updatedAt: 2
    },
    revisions: [],
    runs: [RUN],
    proposals: []
  }
}

describe('ForgeInboxDetail mixed-version display', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    navigate.mockClear()
    repos = []
    pageDetail = null
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(detail: ForgeItemDetailView): void {
    act(() =>
      root.render(
        <ForgeInboxDetail
          ownerTarget={{ kind: 'local' }}
          ownerHostId={null}
          detail={detail}
          questions={[]}
          loading={false}
          error={null}
          onChanged={() => {}}
        />
      )
    )
  }

  it('renders actual old-host runs without inventing a handling state from unread', () => {
    render(oldHostDetail())

    expect(container.textContent).toContain('Actual legacy run result')
    expect(container.textContent).toContain('revision 3')
    // The run itself names the outcome even when the host sends no handling view.
    expect(container.querySelector('header')?.textContent).toContain('Agent run failed')
    expect(container.querySelector('header')?.textContent).not.toMatch(/Handled|Recorded/)
  })

  it('shows the recommendation and offers the merge a person can confirm', () => {
    const detail = oldHostDetail()
    render({
      ...detail,
      item: { ...detail.item, kind: 'merge_request', state: 'opened' },
      runs: [
        {
          ...RUN,
          state: 'succeeded',
          errorCode: null,
          dispatchConfirmation: {
            state: 'confirmed',
            claims: [],
            checkedAt: 3,
            recommendation: { action: 'merge', reason: 'Docs only, safe to merge.' }
          }
        }
      ],
      handling: { state: 'done', errorCode: null },
      timeline: []
    })

    const header = container.querySelector('header')
    // The badge names the workflow state; the recommendation block below carries the advice.
    expect(header?.textContent).toContain('Reviewed')
    expect(header?.textContent).toContain('Ready to merge')
    expect(header?.textContent).toContain('Docs only, safe to merge.')
    expect(container.textContent).toContain('Confirm merge')
  })

  it('marks a run that replied instead of calling it a bare success', () => {
    const detail = oldHostDetail()
    render({
      ...detail,
      runs: [
        {
          ...RUN,
          state: 'succeeded',
          errorCode: null,
          dispatchConfirmation: {
            state: 'confirmed',
            claims: [
              {
                kind: 'comment',
                target: 'issue',
                iid: 7,
                outcome: 'confirmed',
                attribution: 'marker-author'
              }
            ],
            checkedAt: 3
          }
        }
      ],
      handling: { state: 'done', errorCode: null },
      timeline: []
    })

    const header = container.querySelector('header')
    expect(header?.textContent).toContain('Replied')
    expect(header?.textContent).not.toContain('Agent run succeeded')
  })

  it('names a project item by its kind alone, with no number or placeholder state', () => {
    const detail = oldHostDetail()
    render({
      ...detail,
      item: { ...detail.item, kind: 'project', iid: 0, state: 'unknown', title: 'group/demo' },
      handling: { state: 'recorded', errorCode: null },
      timeline: []
    })

    const meta = container.querySelector('header p')?.textContent ?? ''
    expect(meta).toContain('Project')
    expect(meta).toContain('group/demo')
    expect(meta).not.toMatch(/#0|unknown/)
  })

  it('respects an explicitly empty timeline from a new host without replaying runs', () => {
    render({ ...oldHostDetail(), handling: { state: 'recorded', errorCode: null }, timeline: [] })

    expect(container.textContent).toContain('No activity yet.')
    expect(container.textContent).not.toContain('Actual legacy run result')
    expect(container.querySelector('header')?.textContent).toContain('Agent run failed')
  })

  it.each(['secret/path /tmp/x', 'future-backend-error'])(
    'never prints host header code %s',
    (code) => {
      render({ ...oldHostDetail(), handling: { state: 'failed', errorCode: code }, timeline: [] })

      expect(container.querySelector('header')?.textContent).toContain('Something went wrong.')
      expect(container.textContent).not.toContain(code)
      expect(container.querySelector('button')).toBeNull()
    }
  )

  function renderPage(
    errorCode: string,
    repoId?: string,
    errorSource?: ForgeInboxErrorSource
  ): void {
    pageDetail = {
      ...oldHostDetail(),
      repoId,
      handling: { state: 'failed', errorCode, errorSource },
      timeline: [
        {
          kind: 'decision',
          id: 'decision:1',
          at: 1,
          action: 'dispatch_agent',
          state: 'blocked',
          errorCode
        },
        {
          kind: 'run',
          id: `run:${RUN.id}`,
          at: RUN.updatedAt,
          state: RUN.state,
          reason: RUN.reason
        }
      ],
      runs: [{ ...RUN, errorCode }]
    }
    act(() => root.render(<ForgeInboxPage />))
  }

  it('routes project repair clicks from the header, decision and run to the exact catalog-owned repo', () => {
    repos = [
      {
        id: 'repo-42',
        path: '/folder',
        displayName: 'Folder',
        badgeColor: '',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'local'
      },
      {
        id: 'repo-42',
        path: '/other',
        displayName: 'Other host twin',
        badgeColor: '',
        addedAt: 1,
        executionHostId: 'runtime:elsewhere'
      }
    ]
    renderPage('workspace-ambiguous', 'repo-42')

    const buttons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Open project event settings'
    )
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      act(() => button.click())
    }
    expect(navigate.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        {
          pane: 'repo',
          repoId: 'repo-42',
          hostId: 'local',
          hostScope: { kind: 'local' }
        }
      ])
    )
  })

  it.each([undefined, 'group/demo', 'missing-repo', 'remote-only'])(
    'does not fabricate a local project target for absent or unowned metadata %s',
    (repoId) => {
      repos = [
        {
          id: 'remote-only',
          path: '/remote',
          displayName: 'Remote',
          badgeColor: '',
          addedAt: 1,
          executionHostId: 'runtime:elsewhere'
        }
      ]
      renderPage('dispatch-unconfigured', repoId)

      expect(container.textContent).toContain('Project settings are unavailable')
      expect(container.textContent).not.toContain('Open project event settings')
      expect(navigate).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      'unauthorized',
      'decision-provider',
      'agents',
      'agents-event-decision',
      'Open event decision settings'
    ],
    ['unauthenticated', 'gitlab', 'integrations', 'integrations-gitlab', 'Open Integrations'],
    [
      'receiver-not-configured',
      'receiver',
      'integrations',
      'integrations-webhook',
      'Open Integrations'
    ]
  ] as const)(
    'routes host repair %s to its owning settings section',
    (code, source, pane, sectionId, label) => {
      renderPage(code, undefined, source)
      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label
      )
      expect(button).toBeDefined()
      act(() => button?.click())

      expect(navigate).toHaveBeenCalledWith({
        pane,
        repoId: null,
        hostScope: { kind: 'local' },
        sectionId
      })
    }
  )

  it.each(['unknown', 'agent-failure', 'cancelled', 'arbitrary-error'])(
    'does not offer arbitrary configuration navigation for %s',
    (code) => {
      renderPage(code)

      expect(container.textContent).not.toMatch(
        /Open project event settings|Open Integrations|Open event decision settings/
      )
      expect(navigate).not.toHaveBeenCalled()
    }
  )

  it('localizes a known handling error instead of printing the producer token', () => {
    render({
      ...oldHostDetail(),
      handling: { state: 'failed', errorCode: 'dispatch-unconfigured' },
      timeline: []
    })

    expect(container.querySelector('header')?.textContent).toContain(
      'No agent is configured for this project.'
    )
    expect(container.textContent).not.toContain('dispatch-unconfigured')
  })
})
