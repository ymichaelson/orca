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
  archive: Mock
  unarchive: Mock
  detail: Mock
  status: Mock
  markRead: Mock
  questions: Mock
  projects: Mock
} = vi.hoisted(() => ({
  store: {},
  capabilities: vi.fn(),
  supports: vi.fn(),
  list: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  detail: vi.fn(),
  status: vi.fn(),
  markRead: vi.fn(),
  questions: vi.fn(),
  projects: vi.fn()
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

function item(id: number, ownerHostId: string, title: string): ForgeItem {
  return {
    id,
    hostId: ownerHostId,
    instanceId: 'gitlab:gitlab.test',
    projectId: 'group/demo',
    kind: 'merge_request',
    iid: id,
    title,
    state: 'opened',
    currentRevision: 1,
    activitySeq: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: true,
    archived: false
  }
}

describe('useForgeInboxFeed remote owner archive capability', () => {
  let container: HTMLDivElement
  let root: Root
  let feed: ForgeInboxFeed

  function Probe({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
    feed = useForgeInboxFeed(target)
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

  async function mount(target: RuntimeClientTarget = REMOTE): Promise<void> {
    await act(async () => {
      root.render(<Probe target={target} />)
    })
    await act(async () => {})
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    mocks.capabilities.mockReset()
    mocks.supports.mockReset().mockResolvedValue(true)
    mocks.status.mockReset().mockResolvedValue(statusFor('remote-owner'))
    mocks.projects
      .mockReset()
      .mockResolvedValue({ ownerHostId: 'remote-owner', projects: ['group/demo'] })
    mocks.list.mockReset().mockResolvedValue({
      ownerHostId: 'remote-owner',
      rows: [item(5, 'remote-owner', 'Remote owner item')],
      nextCursor: null
    })
    mocks.detail.mockReset().mockResolvedValue({ ownerHostId: 'remote-owner', detail: null })
    mocks.questions.mockReset().mockResolvedValue({ ownerHostId: 'remote-owner', questions: [] })
    mocks.markRead.mockReset().mockResolvedValue({ marked: true })
    mocks.archive.mockReset().mockResolvedValue({ ownerHostId: 'remote-owner', applied: true })
    mocks.unarchive.mockReset().mockResolvedValue({ ownerHostId: 'remote-owner', applied: true })
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

  it('lists a remote owner while its archive capability is unknown', async () => {
    mocks.supports.mockReturnValue(new Promise(() => undefined))
    await mount()

    expect(mocks.supports).toHaveBeenCalledWith(
      'env-remote',
      FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY
    )
    expect(feed.archiveSupported).toBeNull()
    expect(mocks.list).toHaveBeenCalledWith('remote-owner', { unreadOnly: true, limit: 50 }, REMOTE)
    expect(feed.items.map((row) => row.title)).toEqual(['Remote owner item'])
    let applied = true
    await act(async () => {
      applied = await feed.setItemArchived(5, true)
    })
    expect(applied).toBe(false)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('keeps listing when a remote owner cannot archive', async () => {
    mocks.supports.mockResolvedValue(false)
    await mount()

    expect(mocks.supports).toHaveBeenCalledWith(
      'env-remote',
      FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY
    )
    expect(mocks.list).toHaveBeenCalledWith('remote-owner', { unreadOnly: true, limit: 50 }, REMOTE)
    expect(feed.archiveSupported).toBe(false)
    expect(feed.items.map((row) => row.title)).toEqual(['Remote owner item'])
    let applied = true
    await act(async () => {
      applied = await feed.setItemArchived(5, true)
    })
    expect(applied).toBe(false)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('keeps listing when a remote probe fails', async () => {
    mocks.supports.mockRejectedValue(new Error('archive probe failed'))
    await mount()

    expect(feed.archiveSupported).toBeNull()
    expect(mocks.list).toHaveBeenCalledWith('remote-owner', { unreadOnly: true, limit: 50 }, REMOTE)
    expect(feed.items.map((row) => row.title)).toEqual(['Remote owner item'])
    expect(feed.itemsError).toBeNull()
  })

  it('does not refetch the default view when the archive capability arrives', async () => {
    let resolveProbe: (value: boolean) => void = () => undefined
    mocks.supports.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      })
    )
    mocks.store.forgeInboxArchiveView = 'active'
    await mount()

    expect(mocks.list).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveProbe(true)
    })
    await act(async () => {})

    expect(feed.archiveSupported).toBe(true)
    // Why: an unknown host already returns the default view, so the probe must not clear and refetch.
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.list).toHaveBeenCalledWith('remote-owner', { unreadOnly: true, limit: 50 }, REMOTE)
  })

  it('switching to an environment that supports archive offers archive', async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.supports.mockResolvedValue(true)
    mocks.status.mockImplementation((target?: RuntimeClientTarget) =>
      Promise.resolve(statusFor(target?.kind === 'environment' ? 'remote-owner' : 'local-owner'))
    )
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [item(5, owner, `${owner} item`)],
        nextCursor: null
      })
    )
    mocks.detail.mockImplementation((owner: string) =>
      Promise.resolve({ ownerHostId: owner, detail: null })
    )
    mocks.questions.mockImplementation((owner: string) =>
      Promise.resolve({ ownerHostId: owner, questions: [] })
    )
    await mount(LOCAL)

    expect(mocks.list).toHaveBeenCalledWith(
      'local-owner',
      expect.objectContaining({ limit: 50 }),
      LOCAL
    )

    await act(async () => root.render(<Probe target={REMOTE} />))
    await act(async () => {})

    expect(mocks.status).toHaveBeenLastCalledWith(REMOTE)
    expect(mocks.list).toHaveBeenLastCalledWith(
      'remote-owner',
      expect.objectContaining({ archiveView: 'archived', limit: 50 }),
      REMOTE
    )
    expect(feed.archiveSupported).toBe(true)

    await act(async () => feed.selectItem(5))
    expect(mocks.detail).toHaveBeenLastCalledWith('remote-owner', 5, undefined, REMOTE)

    await act(async () => {
      await feed.setItemArchived(5, true)
    })
    expect(mocks.archive).toHaveBeenCalledWith('remote-owner', 5, undefined, REMOTE)
  })

  it("does not apply a late archive response to the next owner's list", async () => {
    mocks.capabilities.mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.store.forgeInboxArchiveView = 'all'
    mocks.status.mockImplementation((target?: RuntimeClientTarget) =>
      Promise.resolve(statusFor(target?.kind === 'environment' ? 'remote-owner' : 'local-owner'))
    )
    let resolveArchive: (value: { ownerHostId: string; applied: boolean }) => void = () => undefined
    mocks.archive.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveArchive = resolve
      })
    )
    mocks.list.mockImplementation((owner: string) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [item(7, owner, `${owner} item`)],
        nextCursor: null
      })
    )
    mocks.detail.mockImplementation((owner: string) =>
      Promise.resolve({ ownerHostId: owner, detail: null })
    )
    mocks.questions.mockImplementation((owner: string) =>
      Promise.resolve({ ownerHostId: owner, questions: [] })
    )
    const rendered: (readonly ForgeItem[])[] = []
    function Recording({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
      feed = useForgeInboxFeed(target)
      rendered.push(feed.items)
      return <span />
    }
    await act(async () => root.render(<Recording target={LOCAL} />))
    await act(async () => {})
    expect(rendered.at(-1)?.map((row) => row.id)).toEqual([7])

    let operation: Promise<void> = Promise.resolve()
    let applied = false
    act(() => {
      operation = feed.setItemArchived(7, true).then((result) => {
        applied = result
      })
    })
    await act(async () => root.render(<Recording target={REMOTE} />))
    await act(async () => {})
    expect(mocks.list).toHaveBeenLastCalledWith(
      'remote-owner',
      expect.objectContaining({ limit: 50 }),
      REMOTE
    )

    await act(async () => {
      resolveArchive({ ownerHostId: 'local-owner', applied: true })
      await operation
    })
    expect(applied).toBe(true)
    // Why: the local owner's archive must never rewrite the row the remote owner shares the id with.
    expect(rendered.some((rows) => rows.some((row) => row.archived))).toBe(false)
  })
})
