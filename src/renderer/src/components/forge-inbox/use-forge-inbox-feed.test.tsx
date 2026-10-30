// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
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
import { ForgeInboxDetail } from './ForgeInboxDetail'
import { ForgeInboxStatusStrip } from './ForgeInboxStatusStrip'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-remote' }

function statusFor(ownerHostId: string): ForgeInboxStatus {
  return {
    ownerHostId,
    available: true,
    phase: 'running',
    running: true,
    dormant: false,
    listener: { enabled: false, listening: false, port: null, error: null },
    work: { pending: 0, needsAuth: 0, nextAttemptAtMs: null, draining: false }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

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

describe('useForgeInboxFeed archive and display preferences', () => {
  let container: HTMLDivElement
  let root: Root
  let feed: ForgeInboxFeed

  function Probe({ target = LOCAL }: { target?: RuntimeClientTarget }): React.JSX.Element {
    feed = useForgeInboxFeed(target)
    return (
      <>
        <ForgeInboxStatusStrip
          status={feed.status}
          error={feed.statusError}
          loading={feed.loadingStatus}
          onRetry={feed.reload}
        />
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
        <ForgeInboxDetail
          ownerTarget={target}
          ownerHostId={feed.status?.ownerHostId ?? null}
          detail={feed.detail}
          questions={feed.questions}
          loading={feed.loadingDetail}
          error={feed.detailError}
          onChanged={feed.reload}
          archiveSupported={feed.archiveSupported === true}
          onSetArchived={feed.setItemArchived}
        />
      </>
    )
  }

  async function mount(target: RuntimeClientTarget = LOCAL): Promise<void> {
    await act(async () => {
      root.render(<Probe target={target} />)
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

  it.each(['filter', 'reload'] as const)(
    'invalidates pending pages on %s and preserves newer loading state',
    async (change) => {
      mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
      const oldPage = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
      const firstPage = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
      const newPage = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
      mocks.list
        .mockResolvedValueOnce({ rows: [item(1)], nextCursor: 1 })
        .mockReturnValueOnce(oldPage.promise)
        .mockReturnValueOnce(firstPage.promise)
        .mockReturnValueOnce(newPage.promise)
      await mount()
      act(() => feed.loadMore())
      expect(feed.loadingMore).toBe(true)
      if (change === 'filter') {
        mocks.store.forgeInboxArchiveView = 'active'
        mocks.store.forgeInboxUnreadOnly = false
        await act(async () => root.render(<Probe />))
      } else {
        await act(async () => feed.reload())
      }
      act(() => feed.loadMore())
      expect(mocks.list).toHaveBeenCalledTimes(3)
      await act(async () => firstPage.resolve({ rows: [item(2)], nextCursor: 2 }))
      expect(feed.loadingMore).toBe(false)
      act(() => feed.loadMore())
      expect(feed.loadingMore).toBe(true)
      await act(async () => oldPage.resolve({ rows: [item(99)], nextCursor: null }))
      expect(feed.loadingMore).toBe(true)
      expect(feed.items.map((row) => row.id)).toEqual([2])
      await act(async () => newPage.resolve({ rows: [item(3)], nextCursor: null }))
      expect(feed.items.map((row) => row.id)).toEqual([2, 3])
      expect(feed.loadingMore).toBe(false)
    }
  )

  it('renders safe copy for a first-page exception', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.list.mockRejectedValue(new Error('token=secret'))
    await mount()
    expect(container.textContent).not.toContain('token=secret')
    expect(container.textContent).toContain('Something went wrong.')
  })

  it('renders safe copy for a detail exception object', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.detail.mockRejectedValue({ toString: () => 'token=secret' })
    await mount()
    await act(async () => feed.selectItem(1))
    expect(container.textContent).not.toContain('token=secret')
    expect(container.textContent).toContain('Something went wrong.')
  })

  it('renders safe copy for a status exception', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.status.mockRejectedValue(new Error('token=secret'))
    await mount()
    expect(container.textContent).not.toContain('token=secret')
    expect(container.textContent).toContain('Could not read the inbox status')
  })

  it('renders safe copy for a failed next page', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.list
      .mockResolvedValueOnce({ rows: [item(1)], nextCursor: 1 })
      .mockRejectedValueOnce(new Error('token=secret'))
    await mount()
    await act(async () => feed.loadMore())
    expect(container.textContent).not.toContain('token=secret')
    expect(container.textContent).toContain('Something went wrong.')
    expect(container.textContent).toContain('MR 1')
  })

  it.each(['next page', 'first page'] as const)(
    'does not restore an archived item from a pending %s',
    async (pending) => {
      mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
      mocks.store.forgeInboxArchiveView = 'active'
      const oldPage = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
      mocks.list
        .mockResolvedValueOnce({ rows: [item(7)], nextCursor: 7 })
        .mockReturnValueOnce(oldPage.promise)
        .mockResolvedValue({ rows: [], nextCursor: null })
      await mount()
      if (pending === 'next page') {
        act(() => feed.loadMore())
      } else {
        await act(async () => feed.reload())
      }
      let applied = false
      await act(async () => {
        applied = await feed.setItemArchived(7, true)
      })
      expect(applied).toBe(true)
      await act(async () => oldPage.resolve({ rows: [item(7)], nextCursor: null }))
      expect(feed.items.map((row) => row.id)).toEqual([])
      expect(feed.loadingItems).toBe(false)
      expect(feed.loadingMore).toBe(false)
    }
  )

  it('hides old detail while a new item loads', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const next = deferred<{
      detail: { item: ForgeItem; revisions: never[]; runs: never[]; proposals: never[] }
    }>()
    mocks.detail
      .mockResolvedValueOnce({
        detail: { item: item(1), revisions: [], runs: [], proposals: [] }
      })
      .mockReturnValue(next.promise)
    await mount()
    await act(async () => feed.selectItem(1))
    expect(container.querySelector('header')?.textContent).toContain('MR 1')
    await act(async () => feed.selectItem(2))
    expect(container.querySelector('header')).toBeNull()
    await act(async () =>
      next.resolve({ detail: { item: item(2), revisions: [], runs: [], proposals: [] } })
    )
    expect(container.querySelector('header')?.textContent).toContain('MR 2')
  })

  it('never exposes the previous owner row while the new owner list loads', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const next = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
    const oldRow = { ...item(7), title: 'Owner A item' }
    const newRow = { ...item(7), hostId: 'owner-2', title: 'Owner B item' }
    mocks.list.mockImplementation((owner: string) =>
      owner === 'owner-2' ? next.promise : Promise.resolve({ rows: [oldRow], nextCursor: null })
    )
    await mount()
    expect(container.textContent).toContain('Owner A item')
    mocks.status.mockResolvedValue({
      ownerHostId: 'owner-2',
      available: true,
      phase: 'running',
      listener: { error: null, enabled: false },
      work: { pending: 0, needsAuth: 0 }
    })
    await act(async () => feed.reload())
    expect(container.textContent).not.toContain('Owner A item')
    expect(container.textContent).toContain('Loading items')
    expect(mocks.detail).not.toHaveBeenCalled()
    await act(async () => next.resolve({ rows: [newRow], nextCursor: null }))
    expect(container.textContent).toContain('Owner B item')
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Owner B item')
    )
    await act(async () => button?.click())
    expect(mocks.detail).toHaveBeenCalledWith('owner-2', 7, undefined, LOCAL)
  })

  it('preserves a read mark completed while a page is pending', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const page = deferred<{ rows: ForgeItem[]; nextCursor: number | null }>()
    const mark = deferred<{ marked: boolean }>()
    mocks.markRead.mockReturnValueOnce(mark.promise)
    mocks.list
      .mockResolvedValueOnce({ rows: [item(1)], nextCursor: 1 })
      .mockReturnValueOnce(page.promise)
    await mount()
    await act(async () => feed.selectItem(1))
    act(() => feed.loadMore())
    await act(async () => mark.resolve({ marked: true }))
    expect(feed.items[0]?.unread).toBe(false)
    await act(async () => page.resolve({ rows: [item(2)], nextCursor: null }))
    expect(feed.items.map((row) => [row.id, row.unread])).toEqual([
      [1, false],
      [2, true]
    ])
  })

  it('does not apply a late archive response to a different view', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.store.forgeInboxArchiveView = 'active'
    const archive = deferred<{ ownerHostId: string; applied: boolean }>()
    mocks.archive.mockReturnValueOnce(archive.promise)
    mocks.list
      .mockResolvedValueOnce({ rows: [item(7)], nextCursor: null })
      .mockResolvedValue({ rows: [{ ...item(7), archived: true }], nextCursor: null })
    await mount()
    let applied = false
    let operation: Promise<void> = Promise.resolve()
    act(() => {
      operation = feed.setItemArchived(7, true).then((result) => {
        applied = result
      })
    })
    mocks.store.forgeInboxArchiveView = 'all'
    await act(async () => root.render(<Probe />))
    await act(async () => {
      archive.resolve({ ownerHostId: 'owner-1', applied: true })
      await operation
    })
    expect(applied).toBe(true)
    expect(feed.items.map((row) => [row.id, row.archived])).toEqual([[7, true]])
  })

  it('ignores late detail and questions after deselection', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const detail = deferred<{
      detail: { item: ForgeItem; revisions: never[]; runs: never[]; proposals: never[] }
    }>()
    const questions = deferred<{
      questions: {
        id: number
        itemId: number
        question: string
        subject: null
        status: 'open'
        askedAt: number
        answeredAt: null
      }[]
    }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    mocks.questions.mockReturnValueOnce(questions.promise)
    await mount()
    await act(async () => feed.selectItem(1))
    await act(async () => feed.selectItem(null))
    await act(async () => {
      detail.resolve({ detail: { item: item(1), revisions: [], runs: [], proposals: [] } })
      questions.resolve({
        questions: [
          {
            id: 1,
            itemId: 1,
            question: 'late',
            subject: null,
            status: 'open',
            askedAt: 1,
            answeredAt: null
          }
        ]
      })
    })
    expect(feed.detail).toBeNull()
    expect(feed.questions).toEqual([])
    expect(feed.loadingDetail).toBe(false)
    expect(mocks.markRead).not.toHaveBeenCalled()
  })

  it('does not select, fetch or mark the new owner row when an old owner mark completes', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const mark = deferred<{ marked: boolean }>()
    mocks.markRead.mockImplementation((owner: string) =>
      owner === 'owner-2' ? Promise.resolve({ marked: true }) : mark.promise
    )
    const oldItem = { ...item(1), title: 'Owner A item' }
    const newItem = { ...item(1), hostId: 'owner-2', title: 'New owner item' }
    mocks.detail.mockImplementation((owner: string) =>
      Promise.resolve({
        detail: {
          item: owner === 'owner-2' ? newItem : oldItem,
          revisions: [],
          runs: [],
          proposals: []
        }
      })
    )
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({ rows: [owner === 'owner-2' ? newItem : oldItem], nextCursor: null })
    )
    await mount()
    await act(async () => feed.selectItem(1))
    expect(container.querySelector('header')?.textContent).toContain('Owner A item')
    expect(feed.selectedItemId).toBe(1)
    expect(mocks.markRead).toHaveBeenCalledWith('owner-1', 1, undefined, LOCAL)
    mocks.status.mockResolvedValue({
      ownerHostId: 'owner-2',
      available: true,
      phase: 'running',
      listener: { error: null, enabled: false },
      work: { pending: 0, needsAuth: 0 }
    })
    await act(async () => feed.reload())
    expect(feed.status?.ownerHostId).toBe('owner-2')
    expect(feed.selectedItemId).toBeNull()
    expect(container.querySelector('header')).toBeNull()
    expect(container.textContent).not.toContain('Owner A item')
    expect(mocks.detail).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(mocks.markRead).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(feed.items[0]?.unread).toBe(true)
    await act(async () => mark.resolve({ marked: true }))
    expect(feed.items[0]?.unread).toBe(true)
    expect(feed.selectedItemId).toBeNull()
    expect(mocks.markRead).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)

    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('New owner item')
    )
    await act(async () => button?.click())
    expect(feed.selectedItemId).toBe(1)
    expect(mocks.detail).toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(mocks.markRead).toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(container.querySelector('header')?.textContent).toContain('New owner item')
  })

  it('drops a pending old-owner detail and questions without selecting the new owner item', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const oldDetail = deferred<{
      detail: { item: ForgeItem; revisions: never[]; runs: never[]; proposals: never[] }
    }>()
    const oldQuestions = deferred<{
      questions: {
        id: number
        itemId: number
        question: string
        subject: null
        status: 'open'
        askedAt: number
        answeredAt: null
      }[]
    }>()
    let ownerOneDetailCalls = 0
    mocks.detail.mockImplementation((owner: string) => {
      if (owner === 'owner-2') {
        return Promise.resolve({
          detail: {
            item: { ...item(1), hostId: 'owner-2', title: 'New owner item' },
            revisions: [],
            runs: [],
            proposals: []
          }
        })
      }
      ownerOneDetailCalls += 1
      return ownerOneDetailCalls === 1 ? oldDetail.promise : Promise.resolve({ detail: null })
    })
    let ownerOneQuestionCalls = 0
    mocks.questions.mockImplementation((owner: string) => {
      if (owner === 'owner-2') {
        return Promise.resolve({ questions: [] })
      }
      ownerOneQuestionCalls += 1
      return ownerOneQuestionCalls === 1 ? oldQuestions.promise : Promise.resolve({ questions: [] })
    })
    const newItem = { ...item(1), hostId: 'owner-2', title: 'New owner item' }
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({ rows: [owner === 'owner-2' ? newItem : item(1)], nextCursor: null })
    )
    await mount()
    await act(async () => feed.selectItem(1))
    expect(mocks.detail).toHaveBeenCalledWith('owner-1', 1, undefined, LOCAL)
    mocks.status.mockResolvedValue({
      ownerHostId: 'owner-2',
      available: true,
      phase: 'running',
      listener: { error: null, enabled: false },
      work: { pending: 0, needsAuth: 0 }
    })
    await act(async () => feed.reload())
    expect(feed.status?.ownerHostId).toBe('owner-2')
    expect(feed.selectedItemId).toBeNull()
    expect(feed.detail).toBeNull()
    expect(feed.questions).toEqual([])
    expect(mocks.detail).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(mocks.markRead).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    await act(async () => {
      oldDetail.resolve({ detail: { item: item(1), revisions: [], runs: [], proposals: [] } })
      oldQuestions.resolve({
        questions: [
          {
            id: 1,
            itemId: 1,
            question: 'late',
            subject: null,
            status: 'open',
            askedAt: 1,
            answeredAt: null
          }
        ]
      })
    })
    expect(feed.selectedItemId).toBeNull()
    expect(feed.detail).toBeNull()
    expect(feed.questions).toEqual([])
    expect(container.querySelector('header')).toBeNull()
    expect(mocks.markRead).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
    expect(mocks.detail).not.toHaveBeenCalledWith('owner-2', 1, undefined, LOCAL)
  })

  it('sends the stored filters to a host that advertises archive', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    await mount()

    expect(mocks.list).toHaveBeenCalledWith(
      'owner-1',
      {
        unreadOnly: true,
        archiveView: 'archived',
        limit: 50
      },
      LOCAL
    )
    expect(feed.archiveSupported).toBe(true)
    expect(feed.archiveView).toBe('archived')
  })

  it('keeps the baseline list call and refuses archive on an older host', async () => {
    mocks.capabilities.mockResolvedValue(['forge-inbox.v1'])
    await mount()

    expect(mocks.list).toHaveBeenCalledWith('owner-1', { unreadOnly: true, limit: 50 }, LOCAL)
    expect(feed.archiveSupported).toBe(false)
    expect(feed.archiveView).toBe('active')
    let applied = true
    await act(async () => {
      applied = await feed.setItemArchived(1, true)
    })
    expect(applied).toBe(false)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('lists active items while the host capabilities are unknown', async () => {
    mocks.capabilities.mockReturnValue(new Promise(() => undefined))
    await mount()

    expect(mocks.list).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ limit: 50 }),
      LOCAL
    )
    // Why: the filter is only trustworthy once the host says it can archive.
    expect(mocks.list.mock.calls[0][1]).not.toHaveProperty('archiveView')
  })

  it('drops an archived item from the active list and writes the preference through the store', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.store.forgeInboxArchiveView = 'active'
    mocks.list
      .mockResolvedValueOnce({ rows: [item(2), item(1)], nextCursor: null })
      .mockResolvedValue({ rows: [item(1)], nextCursor: null })
    await mount()

    await act(async () => {
      await feed.setItemArchived(2, true)
    })
    expect(mocks.archive).toHaveBeenCalledWith('owner-1', 2, undefined, LOCAL)
    expect(feed.items.map((row) => row.id)).toEqual([1])

    act(() => feed.setArchiveView('all'))
    expect(mocks.store.setForgeInboxArchiveView).toHaveBeenCalledWith('all')
    act(() => feed.setUnreadOnly(false))
    expect(mocks.store.setForgeInboxUnreadOnly).toHaveBeenCalledWith(false)
  })

  it('passes the selected owner runtime target to every inbox read', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.supports.mockResolvedValue(true)
    mocks.status.mockResolvedValue(statusFor('remote-owner'))
    mocks.list.mockImplementation((owner: string, query?: { cursor?: number }) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [{ ...item(5), hostId: owner }],
        nextCursor: query?.cursor === undefined ? 9 : null
      })
    )
    mocks.detail.mockResolvedValue({ ownerHostId: 'remote-owner', detail: null })
    mocks.questions.mockResolvedValue({ ownerHostId: 'remote-owner', questions: [] })
    mocks.markRead.mockResolvedValue({ ownerHostId: 'remote-owner', marked: true })
    mocks.archive.mockResolvedValue({ ownerHostId: 'remote-owner', applied: true })
    mocks.unarchive.mockResolvedValue({ ownerHostId: 'remote-owner', applied: true })
    await mount(REMOTE)

    expect(mocks.status).toHaveBeenCalledWith(REMOTE)
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-remote',
      FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY
    )
    expect(mocks.list).toHaveBeenCalledWith(
      'remote-owner',
      { unreadOnly: true, limit: 50, archiveView: 'archived' },
      REMOTE
    )

    await act(async () => feed.selectItem(5))

    expect(mocks.questions).toHaveBeenCalledWith('remote-owner', 'open', REMOTE)
    expect(mocks.detail).toHaveBeenCalledWith('remote-owner', 5, undefined, REMOTE)
    expect(mocks.markRead).toHaveBeenCalledWith('remote-owner', 5, undefined, REMOTE)

    await act(async () => {
      await feed.setItemArchived(5, true)
    })
    expect(mocks.archive).toHaveBeenCalledWith('remote-owner', 5, undefined, REMOTE)

    await act(async () => {
      await feed.setItemArchived(5, false)
    })
    expect(mocks.unarchive).toHaveBeenCalledWith('remote-owner', 5, undefined, REMOTE)

    act(() => feed.loadMore())
    expect(mocks.list).toHaveBeenLastCalledWith(
      'remote-owner',
      expect.objectContaining({ cursor: 9 }),
      REMOTE
    )
  })

  it('refetches under a switched owner target and fences the previous owner', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.supports.mockResolvedValue(true)
    const remoteStatus = deferred<ForgeInboxStatus>()
    mocks.status.mockImplementation((target?: RuntimeClientTarget) =>
      target?.kind === 'environment'
        ? remoteStatus.promise
        : Promise.resolve(statusFor('local-owner'))
    )
    const lateLocalDetail = deferred<{ ownerHostId: string; detail: null }>()
    mocks.detail.mockImplementation((owner: string) =>
      owner === 'remote-owner'
        ? Promise.resolve({ ownerHostId: owner, detail: null })
        : lateLocalDetail.promise
    )
    const localItem = { ...item(1), hostId: 'local-owner', title: 'Local owner item' }
    const remoteItem = { ...item(1), hostId: 'remote-owner', title: 'Remote owner item' }
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [owner === 'remote-owner' ? remoteItem : localItem],
        nextCursor: null
      })
    )
    await mount()

    expect(mocks.status).toHaveBeenCalledWith(LOCAL)
    expect(mocks.list).toHaveBeenCalledWith(
      'local-owner',
      expect.objectContaining({ limit: 50 }),
      LOCAL
    )
    await act(async () => feed.selectItem(1))
    expect(mocks.detail).toHaveBeenCalledWith('local-owner', 1, undefined, LOCAL)

    await act(async () => root.render(<Probe target={REMOTE} />))
    await act(async () => {})
    expect(mocks.status).toHaveBeenLastCalledWith(REMOTE)
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-remote',
      FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY
    )
    // Why: the previous owner's status must not stand in while the new host answers.
    expect(feed.status).toBeNull()
    expect(feed.selectedItemId).toBeNull()
    expect(container.textContent).not.toContain('Local owner item')

    await act(async () => remoteStatus.resolve(statusFor('remote-owner')))
    expect(feed.status?.ownerHostId).toBe('remote-owner')
    expect(mocks.list).toHaveBeenCalledWith(
      'remote-owner',
      expect.objectContaining({ limit: 50 }),
      REMOTE
    )
    expect(feed.items.map((row) => row.title)).toEqual(['Remote owner item'])
    expect(feed.selectedItemId).toBeNull()

    await act(async () => lateLocalDetail.resolve({ ownerHostId: 'local-owner', detail: null }))
    expect(feed.detail).toBeNull()
    expect(feed.selectedItemId).toBeNull()
  })

  it('does not carry a selection across two targets that report the same owner', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const ENV_B: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-b' }
    const sharedOwner = 'shared-owner'
    const envBStatus = deferred<ForgeInboxStatus>()
    mocks.status.mockImplementation((target?: RuntimeClientTarget) =>
      target?.kind === 'environment' && target.environmentId === 'env-b'
        ? envBStatus.promise
        : Promise.resolve(statusFor(sharedOwner))
    )
    const lateDetail = deferred<{ ownerHostId: string; detail: null }>()
    mocks.detail.mockImplementation(() => lateDetail.promise)
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [{ ...item(1), hostId: owner, title: 'Shared item' }],
        nextCursor: null
      })
    )
    await mount(REMOTE)
    await act(async () => feed.selectItem(1))
    expect(feed.selectedItemId).toBe(1)
    expect(mocks.detail).toHaveBeenCalledWith(sharedOwner, 1, undefined, REMOTE)

    await act(async () => root.render(<Probe target={ENV_B} />))
    await act(async () => {})
    expect(feed.status).toBeNull()
    expect(feed.selectedItemId).toBeNull()

    await act(async () => envBStatus.resolve(statusFor(sharedOwner)))
    // Both targets name the same owner; only the target leg keeps item 1 from being reused.
    expect(feed.status?.ownerHostId).toBe(sharedOwner)
    expect(feed.selectedItemId).toBeNull()

    await act(async () => lateDetail.resolve({ ownerHostId: sharedOwner, detail: null }))
    expect(feed.detail).toBeNull()
    expect(feed.selectedItemId).toBeNull()

    await act(async () => feed.selectItem(1))
    expect(feed.selectedItemId).toBe(1)
    expect(mocks.detail).toHaveBeenCalledWith(sharedOwner, 1, undefined, ENV_B)
  })

  it('does not let a stale status rejection paint an error on the new owner', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    const ENV_A: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-a' }
    const ENV_B: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-b' }
    const envAStatus = deferred<ForgeInboxStatus>()
    mocks.status.mockImplementation((target?: RuntimeClientTarget) =>
      target?.kind === 'environment' && target.environmentId === 'env-a'
        ? envAStatus.promise
        : Promise.resolve(statusFor('b-owner'))
    )
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({ ownerHostId: owner, rows: [], nextCursor: null })
    )
    await mount(ENV_A)
    await act(async () => root.render(<Probe target={ENV_B} />))
    await act(async () => {})
    expect(feed.status?.ownerHostId).toBe('b-owner')

    await act(async () => envAStatus.reject(new Error('stale status failure')))

    expect(feed.statusError).toBeNull()
    expect(feed.status?.ownerHostId).toBe('b-owner')
  })
})
