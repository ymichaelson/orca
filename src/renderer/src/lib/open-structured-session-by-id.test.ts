import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'

type HostState = {
  tabs: Record<string, unknown[]>
  active: { worktreeId: string; tabId: string } | null
  activeWorktreeId: string | null
  reveal: Mock<(sessionId: string) => unknown>
  toast: ReturnType<typeof vi.fn>
}

const host = vi.hoisted((): HostState => ({
  tabs: {},
  active: null,
  activeWorktreeId: null,
  reveal: vi.fn(),
  toast: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: host.toast } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: host.tabs,
      activeWorktreeId: host.activeWorktreeId,
      focusGroup: () => undefined,
      activateTab: (tabId: string, options: { worktreeId: string }) => {
        host.active = { worktreeId: options.worktreeId, tabId }
      },
      setActiveTabType: () => undefined
    })
  }
}))
vi.mock('./worktree-runtime-owner', () => ({
  runtimeEnvironmentIdWithLegacyFallbackUnlessTwin: () => null
}))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: () => undefined }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus: () => undefined
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: { sessionId: string }) =>
    method === 'agentSession.reveal' ? host.reveal(params.sessionId) : { ok: true },
  runtimeEnvironmentSupportsCapability: async () => true
}))

import { openStructuredSessionById } from './open-structured-session-by-id'

function chatTab(id: string, executionHostId: ExecutionHostId): Tab {
  return {
    id,
    worktreeId: 'wt-7',
    groupId: 'group-1',
    contentType: 'agent-session',
    entityId: 'session-1',
    executionHostId,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } satisfies Tab
}

beforeEach(() => {
  host.tabs = {}
  host.active = null
  host.reveal.mockReset()
  host.toast.mockReset()
})

describe('openStructuredSessionById', () => {
  it('opens the local tab of the recorded session, not a same-id tab of another host', async () => {
    host.tabs = {
      'wt-7': [chatTab('remote-tab', 'runtime:server-b'), chatTab('local-tab', 'local')]
    }
    host.reveal.mockResolvedValue({ ok: true, sessionId: 'session-1', workspaceId: 'wt-7' })

    await openStructuredSessionById('session-1', { kind: 'local' })

    expect(host.reveal).toHaveBeenCalledWith('session-1')
    expect(host.active).toEqual({ worktreeId: 'wt-7', tabId: 'local-tab' })
    expect(host.toast).not.toHaveBeenCalled()
  })

  it('says the chat is gone when the host holds no such record', async () => {
    host.reveal.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_identity_required' }
    })

    await openStructuredSessionById('session-1', { kind: 'local' })

    expect(host.active).toBeNull()
    expect(host.toast).toHaveBeenCalledWith(
      'This chat is no longer on this host, so it cannot be reopened here.'
    )
  })

  it('says an update is needed when the host cannot open the chat', async () => {
    host.reveal.mockResolvedValue({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })

    await openStructuredSessionById('session-1', { kind: 'local' })

    expect(host.active).toBeNull()
    expect(host.toast).toHaveBeenCalledWith("This chat can't be reopened until Orca is updated.")
  })
})
