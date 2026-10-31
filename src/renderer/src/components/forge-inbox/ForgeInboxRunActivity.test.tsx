// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'

const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: rpc.subscribe }))

import { resetStructuredAgentSessionReadOwnersForTests } from '../native-chat/structured-agent-session-read-owner'
import { ForgeInboxRunActivity } from './ForgeInboxRunActivity'

function item(
  itemId: string,
  body: AgentJournalItemBody,
  sequence: number
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence * 10, body }
}

function historyPage(items: AgentJournalRenderItem[]) {
  return {
    ok: true as const,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      direction: 'tail' as const,
      items,
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 2 } },
      hasOlder: false
    }
  }
}

const ITEMS = [
  item(
    '1',
    { kind: 'tool-call', name: 'Read', input: { file_path: 'src/a.ts' }, state: 'completed' },
    1
  ),
  item(
    '2',
    { kind: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, state: 'failed' },
    2
  )
]

describe('ForgeInboxRunActivity', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    rpc.call.mockReset()
    rpc.subscribe.mockReset()
    rpc.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.history' ? historyPage(ITEMS) : undefined
    )
    rpc.subscribe.mockResolvedValue({ unsubscribe: () => undefined })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    resetStructuredAgentSessionReadOwnersForTests()
  })

  async function render(): Promise<string> {
    await act(async () => {
      root.render(<ForgeInboxRunActivity sessionId="session-1" target={{ kind: 'local' }} />)
    })
    return container.textContent ?? ''
  }

  it('shows what the dispatched agent ran, newest first, straight from its session journal', async () => {
    const text = await render()

    expect(rpc.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.history', {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 200
    })
    expect(text).toContain('Activity')
    expect(text.indexOf('pnpm test')).toBeLessThan(text.indexOf('src/a.ts'))
    expect(text).toContain('failed')
  })

  it('shows nothing before the session has a step, rather than claiming it is working', async () => {
    rpc.call.mockImplementation(async () => historyPage([]))

    const text = await render()

    expect(text).not.toContain('running')
    expect(text).not.toContain('Activity')
  })
})
