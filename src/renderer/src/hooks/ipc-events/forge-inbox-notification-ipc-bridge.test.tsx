// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../shared/forge-inbox-runtime-capabilities'
import type { ForgeInboxNotificationClickTarget } from '../../../../shared/forge-inbox-notification-subject'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { ForgeItem } from '../../../../shared/forge-inbox-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const mocks: {
  status: Mock
  list: Mock
  detail: Mock
  markRead: Mock
  questions: Mock
  archive: Mock
  unarchive: Mock
  projects: Mock
  capabilities: Mock
  supports: Mock
} = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  markRead: vi.fn(),
  questions: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  projects: vi.fn(),
  capabilities: vi.fn(),
  supports: vi.fn()
}))

vi.mock('@/runtime/forge-inbox-client', () => ({
  readForgeInboxStatus: mocks.status,
  listForgeInboxItems: mocks.list,
  listForgeInboxProjects: mocks.projects,
  readForgeInboxItemDetail: mocks.detail,
  markForgeInboxItemRead: mocks.markRead,
  archiveForgeInboxItem: mocks.archive,
  unarchiveForgeInboxItem: mocks.unarchive
}))
vi.mock('@/runtime/project-event-client', () => ({
  readProjectEventQuestions: mocks.questions
}))
// Why: useSyncExternalStore requires the same reference until the next publication.
const localCapabilities = vi.hoisted(() => ({ state: 'unlearned' as const }))

vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.capabilities,
  readLocalRuntimeCapabilityObservation: () => localCapabilities,
  subscribeLocalRuntimeCapabilityObservation: () => () => {}
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, runtimeEnvironmentSupportsCapability: mocks.supports }
})

import { useAppStore } from '@/store'
import ForgeInboxPage from '@/components/forge-inbox/ForgeInboxPage'
import { forgeGenericErrorLabel } from '@/components/forge-inbox/forge-inbox-error-code-copy'
import { registerForgeInboxNotificationIpcBridge } from './forge-inbox-notification-ipc-bridge'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-remote' }
const REMOTE_HOST = 'runtime:env-remote'
const LOCAL_OWNER = 'local-owner'
const REMOTE_OWNER = 'remote-owner'

function item(id: number, hostId: string, title: string): ForgeItem {
  return {
    id,
    hostId,
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

function clickTarget(
  executionHostId: ExecutionHostId,
  ownerId: string
): ForgeInboxNotificationClickTarget {
  return {
    subject: {
      ownerId,
      instanceId: 'gitlab:gitlab.test',
      itemId: 5,
      reason: 'review-request'
    },
    executionHostId
  }
}

describe('Forge Inbox banner click routing', () => {
  let container: HTMLDivElement
  let root: Root
  let clickHandler: ((target: ForgeInboxNotificationClickTarget) => void) | null

  async function flush(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {})
    }
  }

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<ForgeInboxPage />)
    })
    await flush()
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    clickHandler = null
    Object.assign(window, {
      api: {
        ui: {
          onOpenForgeInboxItem: (handler: (target: ForgeInboxNotificationClickTarget) => void) => {
            clickHandler = handler
            return () => {}
          }
        }
      }
    })
    useAppStore.setState({
      activeView: 'terminal',
      previousViewBeforeInbox: 'terminal',
      pendingInboxItem: null,
      forgeInboxOwnerTarget: { kind: 'local' },
      forgeInboxRouteError: false
    })
    mocks.status
      .mockReset()
      .mockImplementation((target?: RuntimeClientTarget) =>
        Promise.resolve(statusFor(target?.kind === 'environment' ? REMOTE_OWNER : LOCAL_OWNER))
      )
    mocks.list.mockReset().mockImplementation((owner: string) =>
      Promise.resolve({
        ownerHostId: owner,
        rows: [
          owner === REMOTE_OWNER
            ? item(5, REMOTE_OWNER, 'Remote item')
            : item(5, LOCAL_OWNER, 'Local item')
        ],
        nextCursor: null
      })
    )
    mocks.projects
      .mockReset()
      .mockImplementation((owner: string) =>
        Promise.resolve({ ownerHostId: owner, projects: ['group/demo'] })
      )
    mocks.detail
      .mockReset()
      .mockImplementation((owner: string) => Promise.resolve({ ownerHostId: owner, detail: null }))
    mocks.markRead
      .mockReset()
      .mockImplementation((owner: string) => Promise.resolve({ ownerHostId: owner, marked: true }))
    mocks.questions
      .mockReset()
      .mockImplementation((owner: string) => Promise.resolve({ ownerHostId: owner, questions: [] }))
    mocks.archive.mockReset().mockResolvedValue({ ownerHostId: LOCAL_OWNER, applied: true })
    mocks.unarchive.mockReset().mockResolvedValue({ ownerHostId: LOCAL_OWNER, applied: true })
    mocks.capabilities.mockReset().mockResolvedValue([FORGE_INBOX_ITEM_ARCHIVE_RUNTIME_CAPABILITY])
    mocks.supports.mockReset().mockResolvedValue(true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const unsubs: (() => void)[] = []
    registerForgeInboxNotificationIpcBridge(unsubs)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('selects the clicked item on a remote owner instead of dropping it for the local owner', async () => {
    await mount()
    expect(mocks.detail).not.toHaveBeenCalled()

    await act(async () => {
      clickHandler?.(clickTarget(REMOTE_HOST, REMOTE_OWNER))
    })
    await flush()

    expect(mocks.detail).toHaveBeenCalledWith(REMOTE_OWNER, 5, undefined, REMOTE)
    expect(mocks.markRead).toHaveBeenCalledWith(REMOTE_OWNER, 5, undefined, REMOTE)
    expect(mocks.status).toHaveBeenLastCalledWith(REMOTE)
    expect(mocks.list).toHaveBeenCalledWith(
      REMOTE_OWNER,
      expect.objectContaining({ limit: 50 }),
      REMOTE
    )
    // The local owner also has item 5; the click must not be answered by it.
    expect(mocks.detail).not.toHaveBeenCalledWith(LOCAL_OWNER, 5, undefined, expect.anything())
    expect(container.textContent).toContain('Remote item')
    expect(container.textContent).not.toContain('Local item')
    expect(useAppStore.getState().pendingInboxItem).toBeNull()
    expect(mocks.status).toHaveBeenCalledWith(LOCAL)
  })

  it('fails closed on an unroutable execution host instead of falling back to local', async () => {
    await mount()
    expect(mocks.detail).not.toHaveBeenCalled()

    await act(async () => {
      clickHandler?.(clickTarget('runtime:unresolved-owner', LOCAL_OWNER))
    })
    await flush()

    expect(container.textContent).toContain(forgeGenericErrorLabel())
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(mocks.markRead).not.toHaveBeenCalled()
    expect(mocks.status).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'environment' }))
    expect(useAppStore.getState().pendingInboxItem).toBeNull()
  })

  it('routes a local banner click to the local owner without failing closed', async () => {
    await mount()

    await act(async () => {
      clickHandler?.(clickTarget('local', LOCAL_OWNER))
    })
    await flush()

    const state = useAppStore.getState()
    expect(state.activeView).toBe('inbox')
    expect(state.forgeInboxOwnerTarget).toEqual(LOCAL)
    expect(state.forgeInboxRouteError).toBe(false)
    expect(mocks.detail).toHaveBeenCalledWith(LOCAL_OWNER, 5, undefined, LOCAL)
    expect(state.pendingInboxItem).toBeNull()
  })
})
