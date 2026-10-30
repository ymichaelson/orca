// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ForgeInboxStatus } from '../../../../shared/forge-inbox-rpc-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getDefaultNotificationSettings } from '../../../../shared/notification-settings-defaults'

const mocks: {
  navigate: Mock
  state: Record<string, unknown>
  feed: Record<string, unknown>
  rpc: Mock
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  state: {},
  feed: {},
  rpc: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))

vi.mock('@/store', () => ({
  useAppStore: (select: (state: Record<string, unknown>) => unknown) => select(mocks.state)
}))
vi.mock('./use-forge-inbox-feed', () => ({ useForgeInboxFeed: () => mocks.feed }))

import ForgeInboxPage from './ForgeInboxPage'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-remote' }

function statusWithListenerError(ownerHostId: string): ForgeInboxStatus {
  return {
    ownerHostId,
    available: true,
    phase: 'running',
    running: true,
    dormant: false,
    listener: { enabled: true, listening: false, port: null, error: 'EADDRINUSE' },
    work: { pending: 0, needsAuth: 0, nextAttemptAtMs: null, draining: false }
  }
}

describe('ForgeInboxPage receiver settings entry', () => {
  let container: HTMLDivElement
  let root: Root

  function receiverSettingsButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open webhook settings'
    )
  }

  function panelReceiverButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.textContent ?? '').includes('Configure receiver')
    )
  }

  async function openSettingsPanel(): Promise<void> {
    const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Settings'
    )
    if (!toggle) {
      throw new Error('no settings toggle')
    }
    await act(async () => toggle.click())
  }

  async function renderPage(ownerTarget: RuntimeClientTarget): Promise<void> {
    mocks.state.forgeInboxOwnerTarget = ownerTarget
    mocks.feed.status = statusWithListenerError(
      ownerTarget.kind === 'local' ? 'local-owner' : 'remote-owner'
    )
    await act(async () => root.render(<ForgeInboxPage />))
    await act(async () => {})
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    mocks.navigate.mockClear()
    mocks.rpc.mockReset()
    mocks.state = {
      closeInboxPage: () => {},
      openSettingsTarget: mocks.navigate,
      repos: [],
      pendingInboxItem: null,
      clearPendingInboxItem: () => {},
      forgeInboxOwnerTarget: LOCAL,
      forgeInboxRouteError: false,
      clearForgeInboxRouteError: () => {},
      forgeInboxCompact: false,
      forgeInboxUnreadOnly: false,
      forgeInboxArchiveView: 'active',
      setForgeInboxUnreadOnly: () => {},
      setForgeInboxArchiveView: () => {},
      setForgeInboxCompact: () => {},
      updateSettings: async () => {},
      settings: { notifications: getDefaultNotificationSettings() },
      runtimeEnvironments: [],
      setForgeInboxOwnerTarget: () => {}
    }
    mocks.feed = {
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
      selectedItemId: null,
      detail: null,
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
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each([LOCAL, REMOTE])(
    'opens the original session on its selected owner: $kind',
    async (target) => {
      mocks.feed.detail = {
        item: {
          id: 1,
          instanceId: 'gitlab:test',
          projectId: 'group/project',
          kind: 'issue',
          iid: 7,
          title: 'Observed issue',
          state: 'opened',
          currentRevision: 1,
          activitySeq: 1,
          unread: true,
          hostId: 'owner',
          createdAt: 1,
          updatedAt: 2
        },
        revisions: [],
        proposals: [],
        runs: [
          {
            id: 12,
            itemId: 1,
            revision: 1,
            state: 'succeeded',
            generation: 1,
            policyGeneration: 1,
            contextDigest: 'digest',
            analysisKind: 'issue',
            reason: 'project-event-dispatch',
            errorCode: null,
            sessionId: 'session-1',
            result: null,
            createdAt: 1,
            updatedAt: 2
          }
        ]
      }
      mocks.rpc.mockResolvedValue({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
      await renderPage(target)
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === 'Open original session'
      )
      expect(button).toBeDefined()
      await act(async () => button?.click())

      expect(mocks.rpc).toHaveBeenCalledWith(
        target,
        'agentSession.reveal',
        { sessionId: 'session-1' },
        expect.anything()
      )
      expect(mocks.rpc).toHaveBeenCalledTimes(1)

      const nextTarget = target.kind === 'local' ? REMOTE : LOCAL
      await renderPage(nextTarget)
      const nextButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === 'Open original session'
      )
      expect(nextButton).toBeDefined()
      await act(async () => nextButton?.click())
      expect(mocks.rpc).toHaveBeenLastCalledWith(
        nextTarget,
        'agentSession.reveal',
        { sessionId: 'session-1' },
        expect.anything()
      )
      expect(mocks.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it.each([LOCAL, REMOTE])(
    'answers questions on the selected owner and after switching from $kind',
    async (target) => {
      mocks.feed.detail = {
        item: {
          id: 1,
          instanceId: 'gitlab:test',
          projectId: 'group/project',
          kind: 'issue',
          iid: 7,
          title: 'Observed issue',
          state: 'opened',
          currentRevision: 1,
          activitySeq: 1,
          unread: true,
          hostId: 'owner',
          createdAt: 1,
          updatedAt: 2
        },
        revisions: [],
        proposals: [],
        runs: []
      }
      mocks.feed.questions = [
        {
          id: 11,
          itemId: 1,
          question: 'Continue?',
          subject: null,
          status: 'open',
          askedAt: 1,
          answeredAt: null
        }
      ]
      mocks.rpc.mockResolvedValue({ ok: false, reason: 'not-found' })

      async function answer(): Promise<void> {
        const textarea = container.querySelector('textarea')
        if (!textarea) {
          throw new Error('no answer textarea')
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        await act(async () => {
          setter?.call(textarea, '  continue  ')
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === 'Send answer'
        )
        expect(button?.disabled).toBe(false)
        await act(async () => button?.click())
      }

      await renderPage(target)
      await answer()
      expect(mocks.rpc).toHaveBeenLastCalledWith(target, 'forgeInbox.answerProjectEventQuestion', {
        ownerHostId: target.kind === 'local' ? 'local-owner' : 'remote-owner',
        questionId: 11,
        answer: 'continue'
      })
      const nextTarget = target.kind === 'local' ? REMOTE : LOCAL
      await renderPage(nextTarget)
      await answer()
      expect(mocks.rpc).toHaveBeenLastCalledWith(
        nextTarget,
        'forgeInbox.answerProjectEventQuestion',
        {
          ownerHostId: nextTarget.kind === 'local' ? 'local-owner' : 'remote-owner',
          questionId: 11,
          answer: 'continue'
        }
      )
      expect(mocks.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it('describes the empty Inbox without retired approval or provider-specific copy', async () => {
    await renderPage(LOCAL)

    expect(container.textContent).toContain('No items yet. New project activity will appear here.')
    expect(container.textContent).toContain(
      'Select an item to see its activity, runs and questions.'
    )
  })

  it('does not offer this computer’s receiver settings for a remote owner', async () => {
    await renderPage(REMOTE)

    expect(receiverSettingsButton()).toBeUndefined()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('still offers the receiver settings for the local owner', async () => {
    await renderPage(LOCAL)

    const button = receiverSettingsButton()
    expect(button).toBeDefined()
    act(() => button?.click())

    expect(mocks.navigate).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      hostScope: { kind: 'local' },
      sectionId: 'integrations-webhook'
    })
  })

  it('does not offer this computer’s receiver settings in the settings panel for a remote owner', async () => {
    await renderPage(REMOTE)
    await openSettingsPanel()

    expect(panelReceiverButton()).toBeUndefined()
  })

  it('offers the receiver settings in the settings panel for the local owner', async () => {
    await renderPage(LOCAL)
    await openSettingsPanel()

    const button = panelReceiverButton()
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ pane: 'integrations', sectionId: 'integrations-webhook' })
    )
  })
})
