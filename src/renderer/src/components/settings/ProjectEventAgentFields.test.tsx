// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import { ProjectEventAgentFields } from './ProjectEventAgentFields'
import type { ProjectEventAgentDraft } from './use-project-event-agent-settings'

const fake = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: fake.call
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

const SERVER_A: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-a' }
const SERVER_B: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-b' }
const AGENTS: ComponentProps<typeof ProjectEventAgentFields>['agents'] = [
  { id: 'claude', label: 'Claude', cmd: 'claude', homepageUrl: 'https://example.test' },
  { id: 'codex', label: 'Codex', cmd: 'codex', homepageUrl: 'https://example.test' },
  { id: 'gemini', label: 'Gemini', cmd: 'gemini', homepageUrl: 'https://example.test' }
]

function listing(...ids: string[]): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  return {
    origin: 'probe',
    fetchedAt: 1,
    models: ids.map((id) => ({
      id,
      label: id.toUpperCase(),
      isDefault: false,
      efforts: []
    }))
  }
}

function answerFor(
  answers: Record<string, AgentSessionModelCatalogResult | Error>
): (target: RuntimeClientTarget, method: string, params: { agent: string }) => Promise<unknown> {
  return async (target, _method, params) => {
    const host = target.kind === 'environment' ? target.environmentId : 'local'
    const answer = answers[`${host}:${params.agent}`] ?? new Error('method_not_found')
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  }
}

let latest: ProjectEventAgentDraft

function Harness({
  target = SERVER_A,
  initial
}: {
  target?: RuntimeClientTarget
  initial: Partial<ProjectEventAgentDraft>
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProjectEventAgentDraft>({
    enabled: false,
    agentId: 'claude',
    model: '',
    rules: 'Read only.',
    ...initial
  })
  latest = draft
  return (
    <ProjectEventAgentFields
      repoId="repo"
      target={target}
      draft={draft}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      agents={AGENTS}
      detectedIds={null}
      rulesBytes={0}
      rulesRejected={false}
      showEnabled={false}
    />
  )
}

async function openModelList(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Model' }))
}

beforeEach(() => {
  fake.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})
afterEach(cleanup)

describe('project event model field', () => {
  it('lists the selected agent’s catalog models and stores the chosen id', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': listing('opus', 'sonnet') }))
    const user = userEvent.setup()
    render(<Harness initial={{}} />)

    await waitFor(() => expect(fake.call).toHaveBeenCalled())
    await openModelList(user)
    expect(await screen.findByRole('option', { name: 'OPUS' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Agent default' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Custom model…' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'SONNET' }))

    expect(latest.model).toBe('sonnet')
    expect(screen.queryByRole('textbox', { name: 'Custom model name' })).toBeNull()
  })

  it('returns to an empty model for the agent default', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': listing('opus') }))
    const user = userEvent.setup()
    render(<Harness initial={{ model: 'opus' }} />)

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('OPUS')
    )
    await openModelList(user)
    await user.click(await screen.findByRole('option', { name: 'Agent default' }))

    expect(latest.model).toBe('')
  })

  it('accepts a typed custom model and keeps a saved off-catalog model visible', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': listing('opus') }))
    const user = userEvent.setup()
    const { unmount } = render(<Harness initial={{}} />)

    await waitFor(() => expect(fake.call).toHaveBeenCalled())
    await openModelList(user)
    await user.click(await screen.findByRole('option', { name: 'Custom model…' }))
    await user.type(screen.getByRole('textbox', { name: 'Custom model name' }), 'my-model')
    expect(latest.model).toBe('my-model')
    unmount()

    render(<Harness initial={{ model: 'retired-model' }} />)
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Custom model…')
    expect(screen.getByRole('textbox', { name: 'Custom model name' })).toHaveValue('retired-model')
  })

  it('keeps the custom input while its text is cleared', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': listing('opus') }))
    const user = userEvent.setup()
    render(<Harness initial={{ model: 'retired-model' }} />)

    await user.clear(screen.getByRole('textbox', { name: 'Custom model name' }))

    expect(latest.model).toBe('')
    expect(screen.getByRole('textbox', { name: 'Custom model name' })).toBeInTheDocument()
  })

  it('clears the model when the agent changes and lists the new agent’s models', async () => {
    fake.call.mockImplementation(
      answerFor({
        'server-a:claude': listing('opus'),
        'server-a:codex': listing('gpt-5')
      })
    )
    const user = userEvent.setup()
    render(<Harness initial={{ model: 'opus' }} />)

    await user.click(screen.getByRole('combobox', { name: 'Agent' }))
    await user.click(await screen.findByRole('option', { name: 'Codex' }))

    expect(latest).toMatchObject({ agentId: 'codex', model: '' })
    await openModelList(user)
    expect(await screen.findByRole('option', { name: 'GPT-5' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OPUS' })).toBeNull()
  })

  it('says so and keeps manual entry when the host fails or lists nothing', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': new Error('method_not_found') }))
    const user = userEvent.setup()
    const failed = render(<Harness initial={{}} />)
    expect(await screen.findByText(/Could not read the model list/)).toBeInTheDocument()
    await openModelList(user)
    await user.click(await screen.findByRole('option', { name: 'Custom model…' }))
    expect(screen.getByRole('textbox', { name: 'Custom model name' })).toBeEnabled()
    failed.unmount()

    fake.call.mockImplementation(answerFor({ 'server-a:claude': { origin: 'unknown' } }))
    const empty = render(<Harness initial={{}} />)
    expect(await screen.findByText(/listed no models/)).toBeInTheDocument()
    empty.unmount()
  })

  it('asks the owner host for any other agent’s models and stores the chosen one', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:gemini': listing('flash', 'pro') }))
    const user = userEvent.setup()
    render(<Harness initial={{ agentId: 'gemini' }} />)

    await waitFor(() =>
      expect(fake.call).toHaveBeenCalledWith(SERVER_A, 'agentSession.modelCatalog', {
        agent: 'gemini'
      })
    )
    await openModelList(user)
    await user.click(await screen.findByRole('option', { name: 'PRO' }))

    expect(latest).toMatchObject({ agentId: 'gemini', model: 'pro' })
  })

  it('falls back to manual entry when an older host refuses another agent’s catalog', async () => {
    fake.call.mockImplementation(answerFor({}))
    const user = userEvent.setup()
    render(<Harness initial={{ agentId: 'gemini' }} />)

    expect(await screen.findByText(/Could not read the model list/)).toBeInTheDocument()
    await openModelList(user)
    await user.click(await screen.findByRole('option', { name: 'Custom model…' }))
    expect(screen.getByRole('textbox', { name: 'Custom model name' })).toBeEnabled()
  })

  it('shows a loading status until the host answers', async () => {
    fake.call.mockReturnValue(new Promise(() => {}))
    render(<Harness initial={{}} />)

    expect(screen.getByText(/Loading the agent’s models/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled()
  })

  it('reads the catalog from the captured owner target and never leaks another host’s models', async () => {
    fake.call.mockImplementation(
      answerFor({
        'server-a:claude': listing('opus'),
        'server-b:claude': listing('haiku')
      })
    )
    const user = userEvent.setup()
    const view = render(<Harness target={SERVER_A} initial={{}} />)

    await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(1))
    expect(fake.call.mock.calls[0]?.[0]).toEqual(SERVER_A)
    await openModelList(user)
    expect(await screen.findByRole('option', { name: 'OPUS' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    view.rerender(<Harness target={SERVER_B} initial={{}} />)
    await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(2))
    expect(fake.call.mock.calls[1]?.[0]).toEqual(SERVER_B)
    await openModelList(user)
    expect(await screen.findByRole('option', { name: 'HAIKU' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OPUS' })).toBeNull()
    expect(fake.call.mock.calls.every(([target]) => target.kind === 'environment')).toBe(true)
  })

  it('waits for a listing the host reports running', async () => {
    fake.call.mockImplementation(
      async (_target: RuntimeClientTarget, _method: string, params: { waitForListing?: true }) =>
        params.waitForListing
          ? listing('opus')
          : ({ origin: 'unknown', listingInProgress: true } as const)
    )
    const user = userEvent.setup()
    render(<Harness initial={{}} />)

    await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(2))
    await openModelList(user)
    expect(await screen.findByRole('option', { name: 'OPUS' })).toBeInTheDocument()
  })

  it('keeps native chat’s per-workspace answers when this page reads the same host', async () => {
    recordHostModelCatalogSnapshot(SERVER_A, 'claude', 'wt-1', listing('workspace-model'))
    fake.call.mockImplementation(answerFor({ 'server-a:claude': listing('opus') }))
    render(<Harness initial={{}} />)

    await waitFor(() => expect(fake.call).toHaveBeenCalled())
    await act(async () => {
      await fake.call.mock.results[0]?.value
    })
    expect(
      readHostModelCatalogSnapshot(SERVER_A, 'claude', {
        newLaunch: true,
        worktree: 'wt-1',
        seedsModel: false
      })
    ).toMatchObject({ models: [{ id: 'workspace-model' }] })
  })

  it('announces status changes politely and shows none before an agent is chosen', async () => {
    fake.call.mockImplementation(answerFor({ 'server-a:claude': new Error('method_not_found') }))
    render(<Harness initial={{ agentId: null }} />)

    expect(screen.queryByText(/No model list is available/)).toBeNull()
    expect(screen.getByText(/Choose the model the agent should use/)).toHaveAttribute(
      'aria-live',
      'polite'
    )
    expect(fake.call).not.toHaveBeenCalled()
  })

  it('notes that a list the host says differs per workspace may be incomplete', async () => {
    fake.call.mockImplementation(
      answerFor({ 'server-a:claude': { ...listing('opus'), modelsDifferByWorkspace: true } })
    )
    render(<Harness initial={{}} />)

    expect(await screen.findByText(/may differ per workspace/)).toBeInTheDocument()
  })

  it('shares one waiting read between two pages on the same host and agent', async () => {
    let finish: (value: AgentSessionModelCatalogResult) => void = () => {}
    const listed = new Promise<AgentSessionModelCatalogResult>((resolve) => {
      finish = resolve
    })
    fake.call.mockImplementation(
      async (_target: RuntimeClientTarget, _method: string, params: { waitForListing?: true }) =>
        params.waitForListing ? listed : ({ origin: 'unknown', listingInProgress: true } as const)
    )
    render(
      <>
        <Harness initial={{}} />
        <Harness initial={{}} />
      </>
    )

    await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(3))
    expect(fake.call.mock.calls.filter(([, , params]) => params.waitForListing)).toHaveLength(1)
    await act(async () => finish(listing('opus')))
    await waitFor(() => expect(screen.queryByText(/Loading the agent/)).toBeNull())
  })
})
