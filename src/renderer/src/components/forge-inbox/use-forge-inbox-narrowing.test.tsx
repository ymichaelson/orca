// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { ForgeItem } from '../../../../shared/forge-inbox-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ForgeInboxFeed } from './use-forge-inbox-feed'

const mocks: {
  store: Record<string, unknown>
  capabilities: Mock
  supports: Mock
  list: Mock
  projects: Mock
  archive: Mock
  unarchive: Mock
  detail: Mock
  status: Mock
  markRead: Mock
  questions: Mock
} = vi.hoisted(() => ({
  store: {},
  capabilities: vi.fn(),
  supports: vi.fn(),
  list: vi.fn(),
  projects: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  detail: vi.fn(),
  status: vi.fn(),
  markRead: vi.fn(),
  questions: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (select: (value: Record<string, unknown>) => unknown) => select(mocks.store)
}))
vi.mock('@/runtime/local-runtime-capabilities', () => {
  let observation: { state: string; capabilities?: readonly string[] } = { state: 'unlearned' }
  const listeners = new Set<() => void>()
  return {
    ensureLocalRuntimeCapabilities: async () => {
      const capabilities = await mocks.capabilities()
      observation = { state: 'known', capabilities }
      listeners.forEach((listener) => listener())
      return capabilities
    },
    // Why: useSyncExternalStore needs the same reference until the next publication.
    readLocalRuntimeCapabilityObservation: () => observation,
    subscribeLocalRuntimeCapabilityObservation: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
})
vi.mock('@/runtime/forge-inbox-client', () => ({
  readForgeInboxStatus: mocks.status,
  listForgeInboxItems: mocks.list,
  listForgeInboxProjects: mocks.projects,
  archiveForgeInboxItem: mocks.archive,
  unarchiveForgeInboxItem: mocks.unarchive,
  markForgeInboxItemRead: mocks.markRead,
  readForgeInboxItemDetail: mocks.detail
}))
vi.mock('@/runtime/project-event-client', () => ({
  readProjectEventQuestions: mocks.questions
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, runtimeEnvironmentSupportsCapability: mocks.supports }
})

import { useForgeInboxFeed } from './use-forge-inbox-feed'
import { ForgeInboxList } from './ForgeInboxList'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

function item(id: number): ForgeItem {
  return {
    id,
    hostId: 'owner-1',
    instanceId: 'gitlab:gitlab.test',
    projectId: 'group/demo',
    kind: 'merge_request',
    iid: id,
    title: `MR ${id}`,
    state: 'opened',
    currentRevision: 1,
    activitySeq: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: true,
    archived: false
  }
}

describe('useForgeInboxFeed project and kind narrowing', () => {
  let container: HTMLDivElement
  let root: Root
  let feed: ForgeInboxFeed

  function Probe(): React.JSX.Element {
    feed = useForgeInboxFeed(LOCAL)
    return (
      <ForgeInboxList
        items={feed.items}
        selectedItemId={feed.selectedItemId}
        unreadOnly={feed.unreadOnly}
        archiveView={feed.archiveView}
        archiveSupported={feed.archiveSupported}
        projectFilter={feed.projectFilter}
        kindFilter={feed.kindFilter}
        handlingFilter={feed.handlingFilter}
        projects={feed.projects}
        compact={false}
        loading={feed.loadingItems}
        loadingMore={feed.loadingMore}
        hasMore={feed.hasMore}
        error={feed.itemsError}
        onSelect={feed.selectItem}
        onToggleUnreadOnly={() => {}}
        onArchiveViewChange={feed.setArchiveView}
        onProjectFilterChange={feed.setProjectFilter}
        onKindFilterChange={feed.setKindFilter}
        onHandlingFilterChange={feed.setHandlingFilter}
        onLoadMore={feed.loadMore}
        onRetry={feed.reload}
      />
    )
  }

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<Probe />)
    })
    await act(async () => {})
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    mocks.list.mockReset().mockResolvedValue({ rows: [item(2), item(1)], nextCursor: null })
    mocks.projects
      .mockReset()
      .mockResolvedValue({ ownerHostId: 'owner-1', projects: ['group/demo', 'other/tool'] })
    mocks.detail.mockReset().mockResolvedValue({ detail: null })
    mocks.status.mockReset().mockResolvedValue({
      ownerHostId: 'owner-1',
      available: true,
      phase: 'running',
      listener: { error: null, enabled: false },
      work: { pending: 0, needsAuth: 0 }
    })
    mocks.markRead.mockReset().mockResolvedValue({ marked: true })
    mocks.questions.mockReset().mockResolvedValue({ questions: [] })
    mocks.capabilities.mockReset().mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.supports.mockReset().mockResolvedValue(true)
    mocks.archive.mockReset().mockResolvedValue({ ownerHostId: 'owner-1', applied: true })
    mocks.unarchive.mockReset().mockResolvedValue({ ownerHostId: 'owner-1', applied: true })
    mocks.store = {
      forgeInboxUnreadOnly: true,
      forgeInboxArchiveView: 'archived',
      setForgeInboxUnreadOnly: vi.fn(),
      setForgeInboxArchiveView: vi.fn()
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('asks the host for one project and one kind, and offers the projects it names', async () => {
    await mount()

    expect(container.textContent).toContain('All projects')
    expect(container.textContent).toContain('All kinds')
    expect(mocks.list).toHaveBeenLastCalledWith(
      'owner-1',
      { unreadOnly: true, archiveView: 'archived', limit: 50 },
      LOCAL
    )

    await act(async () => feed.setKindFilter('issue'))
    expect(mocks.list).toHaveBeenLastCalledWith(
      'owner-1',
      { unreadOnly: true, archiveView: 'archived', limit: 50, kind: 'issue' },
      LOCAL
    )

    await act(async () => feed.setProjectFilter('other/tool'))
    expect(mocks.list).toHaveBeenLastCalledWith(
      'owner-1',
      {
        unreadOnly: true,
        archiveView: 'archived',
        limit: 50,
        kind: 'issue',
        projectId: 'other/tool'
      },
      LOCAL
    )
    expect(feed.selectedItemId).toBeNull()
  })

  it('asks the host for one handling state and clears the selection', async () => {
    await mount()
    expect(container.textContent).toContain('Any status')

    await act(async () => feed.setHandlingFilter('needs-user'))

    expect(mocks.list).toHaveBeenLastCalledWith(
      'owner-1',
      { unreadOnly: true, archiveView: 'archived', limit: 50, handling: 'needs-user' },
      LOCAL
    )
    expect(feed.selectedItemId).toBeNull()
  })

  it('drops a project filter the host no longer names', async () => {
    mocks.projects.mockResolvedValue({ ownerHostId: 'owner-1', projects: ['group/demo'] })
    await mount()
    await act(async () => feed.setProjectFilter('group/demo'))
    expect(feed.projectFilter).toBe('group/demo')

    mocks.projects.mockResolvedValue({ ownerHostId: 'owner-1', projects: [] })
    await act(async () => feed.reload())
    await act(async () => {})

    expect(feed.projectFilter).toBeNull()
    expect(mocks.list).toHaveBeenLastCalledWith(
      'owner-1',
      { unreadOnly: true, archiveView: 'archived', limit: 50 },
      LOCAL
    )
  })
})
