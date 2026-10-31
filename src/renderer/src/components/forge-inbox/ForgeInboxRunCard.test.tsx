// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForgeDispatchConfirmationView } from '../../../../shared/forge-inbox-dispatch-confirmation'
import type { ForgeItemTimelineEntry } from '../../../../shared/forge-inbox-item-timeline'
import type { ForgeRunView } from '../../../../shared/forge-inbox-rpc-types'
const rpc = vi.hoisted(() => ({ call: vi.fn(), toast: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: rpc.toast } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: async () => true
}))

import { ForgeInboxRunCard } from './ForgeInboxRunCard'
import { ForgeInboxTimeline } from './ForgeInboxTimeline'

const RUN: ForgeRunView = {
  id: 12,
  itemId: 1,
  revision: 3,
  state: 'succeeded',
  generation: 1,
  policyGeneration: 1,
  contextDigest: 'digest',
  analysisKind: 'merge_request',
  reason: 'project-event-dispatch',
  errorCode: null,
  sessionId: null,
  result: null,
  createdAt: 1,
  updatedAt: 2
}

function confirmation(
  overrides: Partial<ForgeDispatchConfirmationView> = {}
): ForgeDispatchConfirmationView {
  return { state: 'unconfirmed', claims: [], checkedAt: null, ...overrides }
}

describe('ForgeInboxRunCard dispatch confirmation', () => {
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

  function render(run: ForgeRunView): string {
    act(() => root.render(<ForgeInboxRunCard ownerTarget={{ kind: 'local' }} run={run} />))
    return container.textContent ?? ''
  }

  it('keeps the run badge as the turn verdict and shows the changes as not yet confirmed', () => {
    const text = render({ ...RUN, dispatchConfirmation: confirmation() })

    expect(text).toContain('Agent run succeeded')
    expect(text).toContain('Changes not yet confirmed')
    expect(text).not.toContain('Changes confirmed')
  })

  it('lists each claim as plain text with what GitLab showed', () => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'confirmed',
        checkedAt: 5,
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'marker-author'
          }
        ]
      })
    })

    expect(text).toContain('Changes confirmed')
    expect(text).toContain('Comment on merge request !7: found on GitLab')
  })

  it('says an approval is state-only rather than tying it to the agent', () => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'confirmed',
        claims: [
          {
            kind: 'approve',
            target: 'issue',
            iid: 9,
            outcome: 'confirmed',
            attribution: 'state-only'
          }
        ]
      })
    })

    expect(text).toContain('Approval of issue #9: found on GitLab')
    expect(text).toContain('GitLab shows this state but not who caused it')
  })

  it.each([
    ['contradicted', 'GitLab contradicts the report'],
    ['unconfirmable', 'Changes cannot be confirmed']
  ] as const)('labels a %s verdict and explains it from its fixed code', (state, label) => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state,
        code: state === 'contradicted' ? 'not-approved' : 'report-missing',
        claims: [
          {
            kind: 'approve',
            target: 'merge_request',
            iid: 3,
            outcome: state === 'contradicted' ? 'contradicted' : 'unconfirmable',
            attribution: null
          }
        ]
      })
    })

    expect(text).toContain(label)
    expect(text).toContain(
      state === 'contradicted'
        ? 'Approval of merge request !3: GitLab shows otherwise'
        : 'The agent did not give a readable report of its changes.'
    )
  })

  it('qualifies a confirmation that rests on GitLab state alone', () => {
    const stateOnly = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'confirmed',
        claims: [
          {
            kind: 'merge',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'state-only'
          },
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'marker-author'
          }
        ]
      })
    })
    const attributed = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'confirmed',
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'marker-author'
          }
        ]
      })
    })

    expect(stateOnly).toContain('State matches on GitLab')
    expect(stateOnly).not.toContain('Changes confirmed')
    expect(attributed).toContain('Changes confirmed')
    expect(attributed).not.toContain('State matches on GitLab')
  })

  it('never shows a merge as plainly confirmed, since the same account could have merged it', () => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'confirmed',
        claims: [
          {
            kind: 'merge',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'state-only'
          }
        ]
      })
    })

    expect(text).toContain('State matches on GitLab')
    expect(text).toContain('Merge of merge request !7: found on GitLab')
    expect(text).not.toContain('Changes confirmed')
  })

  it.each([
    [
      'contradicted',
      'unreported-comment',
      'A comment from this agent was found that its report left out.'
    ],
    [
      'unconfirmable',
      'read-only-unchecked',
      'The agent reported no changes, but GitLab could not be checked for stray comments.'
    ],
    [
      'unconfirmable',
      'head-moved',
      'The revision on GitLab differs from the one the agent worked on.'
    ]
  ] as const)('explains a %s verdict with code %s', (state, code, sentence) => {
    expect(render({ ...RUN, dispatchConfirmation: confirmation({ state, code }) })).toContain(
      sentence
    )
  })

  it('shows claims of an unsure agent as reported, not verified', () => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({
        state: 'unconfirmable',
        code: 'mode-unknown',
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'marker-author'
          },
          {
            kind: 'approve',
            target: 'merge_request',
            iid: 7,
            outcome: 'unproven',
            attribution: null
          }
        ]
      })
    })

    expect(text).toContain('Changes cannot be confirmed')
    expect(text).toContain('Comment on merge request !7: reported, not verified')
    expect(text).toContain('Approval of merge request !7: not found yet')
    expect(text).not.toContain('found on GitLab')
    expect(text).toContain('The agent was unsure what it changed, so its report is not verified.')
  })

  it('shows a read-only report as no remote changes reported', () => {
    const text = render({
      ...RUN,
      dispatchConfirmation: confirmation({ state: 'no-claim', code: 'read-only-report' })
    })

    expect(text).toContain('Agent reported no remote changes')
  })

  it('shows nothing about changes for a send that never reached the agent', () => {
    const text = render({
      ...RUN,
      state: 'failed',
      errorCode: 'dispatch-failed',
      dispatchConfirmation: confirmation({ state: 'no-claim' })
    })

    expect(text).not.toContain('Agent reported no remote changes')
    expect(text).not.toContain('Changes')
  })

  it('renders a succeeded dispatch from an older host as unknown, never confirmed', () => {
    const text = render(RUN)

    expect(text).toContain('Agent run succeeded')
    expect(text).toContain('Changes unknown')
    expect(text).not.toMatch(/Changes confirmed|Agent reported/)
  })

  it('leaves a run without the field unchanged when it is not a succeeded dispatch', () => {
    const failed = render({ ...RUN, state: 'failed', errorCode: 'dispatch-failed' })
    const analysis = render({ ...RUN, reason: 'review-request' })

    expect(failed).not.toContain('Changes')
    expect(analysis).not.toContain('Changes')
  })

  it('shows the confirmation on a timeline run entry whose run is not loaded', () => {
    const entry: ForgeItemTimelineEntry = {
      kind: 'run',
      id: 'run:12',
      at: 1,
      state: 'succeeded',
      reason: 'project-event-dispatch',
      dispatchConfirmation: confirmation({ state: 'contradicted', code: 'head-moved' })
    }
    act(() =>
      root.render(
        <ForgeInboxTimeline ownerTarget={{ kind: 'local' }} entries={[entry]} runs={[]} />
      )
    )

    expect(container.textContent).toContain('GitLab contradicts the report')
  })
})

describe('ForgeInboxRunCard stop request', () => {
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

  function render(run: ForgeRunView): string {
    act(() => root.render(<ForgeInboxRunCard ownerTarget={{ kind: 'local' }} run={run} />))
    return container.textContent ?? ''
  }

  it.each(['pending', 'accepted'] as const)(
    'shows a running run as stopping while the stop is %s, never as stopped',
    (delivery) => {
      const text = render({
        ...RUN,
        state: 'running',
        cancellation: { requestedAt: 5, delivery }
      })

      expect(text).toContain('Stopping')
      expect(text).not.toContain('Agent running')
      expect(text).not.toContain('Cancelled')
    }
  )

  it.each(['refused', 'unreachable'] as const)(
    'says the stop is not confirmed when it was %s, and the run is not stopped',
    (delivery) => {
      const text = render({
        ...RUN,
        state: 'running',
        cancellation: { requestedAt: 5, delivery }
      })

      expect(text).toContain('Stop not confirmed')
      expect(text).not.toContain('Cancelled')
    }
  )

  it('keeps the settled verdict once the turn proved it, request or not', () => {
    const text = render({
      ...RUN,
      state: 'succeeded',
      cancellation: { requestedAt: 5, delivery: 'accepted' }
    })

    expect(text).toContain('Agent run succeeded')
    expect(text).not.toContain('Stopping')
  })

  it('keeps an older host run that carries no stop request as Running', () => {
    expect(render({ ...RUN, state: 'running' })).toContain('Agent running')
  })
})

describe('ForgeInboxRunCard dispatch snapshot and terminal exit', () => {
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

  function render(run: ForgeRunView): string {
    act(() => root.render(<ForgeInboxRunCard ownerTarget={{ kind: 'local' }} run={run} />))
    return container.textContent ?? ''
  }

  const TERMINAL_RUN: ForgeRunView = {
    ...RUN,
    state: 'unverifiable',
    errorCode: 'terminal-handoff'
  }

  it('shows the Agent and the model it was asked for, and says when that was the Agent default', () => {
    const named = render({
      ...RUN,
      dispatchSnapshot: {
        agentId: 'claude',
        requestedModel: 'claude-sonnet-5-5',
        actualModel: null
      }
    })
    expect(named).toContain('Agent: claude')
    expect(named).toContain('Model requested: claude-sonnet-5-5')
    expect(named).not.toContain('Model reported')

    const standard = render({
      ...RUN,
      dispatchSnapshot: { agentId: 'codex', requestedModel: null, actualModel: 'gpt-x' }
    })
    expect(standard).toContain('Model requested: Agent default')
    expect(standard).toContain('Model reported: gpt-x')
  })

  it('says nothing about the Agent for a run dispatched before it was recorded', () => {
    expect(render(RUN)).not.toContain('Agent:')
  })

  it.each([
    [{ kind: 'exited' as const, value: 0 }, 'exited with code 0'],
    [{ kind: 'exited' as const, value: 3 }, 'exited with code 3'],
    [{ kind: 'signaled' as const, value: 9 }, 'stopped by signal 9'],
    [{ kind: 'operator_close' as const, value: null }, 'closed from Orca'],
    [{ kind: 'unknown' as const, value: null }, 'why is not known']
  ])('shows a terminal exit as a process fact that is not the result', (exit, words) => {
    const text = render({ ...TERMINAL_RUN, terminalExit: { ...exit, observedAt: 9 } })

    expect(text).toContain(words)
    expect(text).toContain('does not show what the agent did')
    expect(text).not.toContain('Agent run succeeded')
  })

  it('shows a terminal dispatch with a stop request as stopping until its exit was seen', () => {
    const cancellation = { requestedAt: 5, delivery: 'accepted' as const }

    expect(render({ ...TERMINAL_RUN, cancellation })).toContain('Stopping')
    expect(
      render({
        ...TERMINAL_RUN,
        cancellation,
        terminalExit: { kind: 'operator_close', value: null, observedAt: 9 }
      })
    ).not.toContain('Stopping')
  })

  it('shows a dispatch result summary as plain text', () => {
    const text = render({ ...RUN, result: { summary: 'Reviewed <b>one</b> file.', concerns: [] } })

    expect(text).toContain('Reviewed <b>one</b> file.')
    expect(container.querySelector('b')).toBeNull()
  })

  describe('original session', () => {
    const DISPATCHED: ForgeRunView = { ...RUN, sessionId: 'structured-claude-1' }
    const button = () =>
      Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Open original session'
      )

    beforeEach(() => {
      rpc.call.mockReset()
      rpc.toast.mockReset()
    })

    it('offers the action only for a dispatch run that recorded a session', () => {
      render(RUN)
      expect(button()).toBeUndefined()
      render({ ...DISPATCHED, reason: 'review_requested' })
      expect(button()).toBeUndefined()
      render(DISPATCHED)
      expect(button()).toBeDefined()
    })

    it('asks the attached runtime to reveal exactly the recorded session and reports a gone chat', async () => {
      rpc.call.mockResolvedValue({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
      render(DISPATCHED)

      await act(async () => {
        button()?.click()
      })

      expect(rpc.call).toHaveBeenCalledWith(
        { kind: 'local' },
        'agentSession.reveal',
        { sessionId: 'structured-claude-1' },
        expect.anything()
      )
      expect(rpc.call).toHaveBeenCalledTimes(1)
      expect(rpc.toast).toHaveBeenCalledWith(
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    })
  })
})
