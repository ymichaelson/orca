// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { useProjectEventAgentSettings } from './use-project-event-agent-settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectEventBindingView } from '../../../../shared/forge-inbox-project-binding'
import type { ProjectEventPolicyView } from '../../../../shared/forge-inbox-project-event-policy'
import type { ForgeInboxProjectEventPolicyWriteOutcome } from '../../../../shared/forge-inbox-rpc-types'
import { DEFAULT_PROJECT_EVENT_RULES } from '../../../../shared/project-event-default-rules'
import { ProjectEventAgentSettingsSection } from './ProjectEventAgentSettingsSection'

const fake = vi.hoisted(() => ({
  status: vi.fn(),
  readPolicy: vi.fn(),
  writePolicy: vi.fn(),
  readActivity: vi.fn(),
  retry: vi.fn(),
  rotate: vi.fn(),
  supports: vi.fn(),
  capabilities: vi.fn(),
  modelCatalog: vi.fn()
}))
const store = vi.hoisted(() => ({ settingsSearchQuery: '' }))
const updateRepo = vi.fn()

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof store) => unknown) => selector(store)
  useAppStore.getState = () => store
  return { useAppStore }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: fake.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: fake.capabilities
}))
vi.mock('@/runtime/forge-inbox-client', () => ({
  readForgeInboxStatus: fake.status
}))
vi.mock('@/runtime/project-event-client', () => ({
  readProjectEventPolicy: fake.readPolicy,
  updateProjectEventPolicy: fake.writePolicy,
  readProjectEventActivity: fake.readActivity,
  retryProjectEvent: fake.retry,
  rotateProjectEventSecret: fake.rotate
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: fake.modelCatalog
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    needsServerUpdate: false,
    refresh: async () => []
  })
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

const CAPABILITY = 'forge-inbox.project-event-agent.v1'
const TARGET = { kind: 'environment', environmentId: 'server-a' } as const

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Alpha',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'runtime:server-a',
    kind: 'git',
    ...overrides
  }
}

function policy(overrides: Partial<ProjectEventPolicyView> = {}): ProjectEventPolicyView {
  return {
    repoId: 'repo',
    generation: 3,
    enabled: false,
    agentId: null,
    model: null,
    rules: 'Read only.',
    automaticAnalysis: false,
    events: {
      reviewRequests: true,
      participatingMergeRequestUpdates: true,
      pipelineFailures: false,
      issueMentions: false,
      issueAssignments: false
    },
    budgets: {
      timeoutSeconds: 600,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      maxRunsPerHour: 12,
      maxConcurrentRuns: 1
    },
    ...overrides
  }
}

function binding(overrides: Partial<ProjectEventBindingView> = {}): ProjectEventBindingView {
  return {
    bindingId: 'binding-1',
    projectPath: 'group/demo',
    gitlabHost: 'gitlab.test:8929',
    gitlabPath: 'group/demo',
    gitlabProjectId: 7,
    callbackUrl: 'https://orca.example.com/webhooks/gitlab/binding-1',
    hookId: 12,
    state: 'connected',
    failure: null,
    secretProtection: 'sealed',
    rejectedEvents: [],
    rotationPending: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function policyView(overrides: { binding?: ProjectEventBindingView | null } = {}) {
  return {
    ownerHostId: 'owner',
    repoId: 'repo',
    policy: policy(),
    binding: overrides.binding === undefined ? null : overrides.binding
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  store.settingsSearchQuery = ''
  fake.capabilities.mockResolvedValue([CAPABILITY])
  fake.supports.mockResolvedValue(true)
  fake.status.mockResolvedValue({ ownerHostId: 'owner', available: true, phase: 'running' })
  fake.readPolicy.mockResolvedValue(policyView())
  fake.readActivity.mockResolvedValue({
    ownerHostId: 'owner',
    repoId: 'repo',
    events: [],
    lastProcessed: null
  })
  fake.modelCatalog.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }]
  })
  updateRepo.mockResolvedValue(true)
})
afterEach(cleanup)

describe('project event agent settings', () => {
  it('reads the repo policy from its owner host and shows the editable draft', async () => {
    fake.readPolicy.mockResolvedValue({ ...policyView(), policy: null })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText('Agent')).toBeTruthy())
    expect(fake.readPolicy).toHaveBeenCalledWith('owner', 'repo', TARGET)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe(
      DEFAULT_PROJECT_EVENT_RULES
    )
  })

  it('says the host build is too old when only the capability is missing', async () => {
    fake.supports.mockResolvedValue(false)
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText(/older Orca build/)).toBeTruthy())
    expect(fake.readPolicy).not.toHaveBeenCalled()
  })

  it('blames the detached inbox service, not the build, when no owner is attached', async () => {
    fake.supports.mockResolvedValue(false)
    fake.status.mockResolvedValue({ ownerHostId: null, available: false, phase: 'detached' })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText(/inbox service is not running/)).toBeTruthy())
    expect(fake.readPolicy).not.toHaveBeenCalled()
  })

  it('never sends a local call for a direct SSH project', async () => {
    render(
      <ProjectEventAgentSettingsSection
        repo={repo({ executionHostId: null, connectionId: 'dev-box' })}
        updateRepo={updateRepo}
        forceVisible
      />
    )

    await waitFor(() => expect(screen.getByText(/cannot reach directly/)).toBeTruthy())
    expect(fake.capabilities).not.toHaveBeenCalled()
    expect(fake.status).not.toHaveBeenCalled()
    expect(fake.readPolicy).not.toHaveBeenCalled()
  })

  it('keeps the user edits after a stale generation and saves them with the reported one', async () => {
    fake.writePolicy
      .mockResolvedValueOnce({
        ok: false,
        ownerHostId: 'owner',
        repoId: 'repo',
        reason: 'stale-generation',
        generation: 5
      })
      .mockResolvedValueOnce({
        ok: true,
        ownerHostId: 'owner',
        repoId: 'repo',
        generation: 6,
        policy: policy({ generation: 6, rules: 'Mine.', enabled: true, agentId: 'codex' })
      })
    fake.readPolicy.mockResolvedValueOnce(policyView()).mockResolvedValueOnce({
      ownerHostId: 'owner',
      repoId: 'repo',
      policy: policy({ generation: 5 }),
      binding: null
    })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText('Agent')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByLabelText('Agent'))
    fireEvent.click(
      await screen.findByRole('option', { name: 'Codex — not detected on this host' })
    )
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Mine.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save project event settings' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Your edits were kept/)
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Mine.')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(fake.writePolicy.mock.calls[0]?.[2]).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'Save project event settings' }))
    await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(2))
    expect(fake.writePolicy.mock.calls[1]?.[2]).toBe(5)
    expect(fake.writePolicy.mock.calls[1]?.[3]).toEqual({
      enabled: true,
      agentId: 'codex',
      model: null,
      rules: 'Mine.'
    })
  })

  it('saves a model chosen from the owner host’s list, reading that list from the owner target', async () => {
    fake.readPolicy.mockResolvedValue({
      ...policyView(),
      policy: policy({ agentId: 'claude' })
    })
    fake.writePolicy.mockResolvedValue({
      ok: true,
      ownerHostId: 'owner',
      repoId: 'repo',
      generation: 4,
      policy: policy({ generation: 4, agentId: 'claude', model: 'sonnet' })
    })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await screen.findByLabelText('Rules')
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(await screen.findByRole('option', { name: 'Sonnet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save project event settings' }))

    await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(1))
    expect(fake.writePolicy.mock.calls[0]?.[3]).toMatchObject({
      agentId: 'claude',
      model: 'sonnet'
    })
    expect(fake.modelCatalog).toHaveBeenCalledWith(TARGET, 'agentSession.modelCatalog', {
      agent: 'claude'
    })
  })

  it('sends one write when the save button is clicked twice', async () => {
    let settle: (value: ForgeInboxProjectEventPolicyWriteOutcome) => void = () => {}
    fake.writePolicy.mockReturnValue(
      new Promise<ForgeInboxProjectEventPolicyWriteOutcome>((resolve) => {
        settle = resolve
      })
    )
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText('Agent')).toBeTruthy())
    const save = screen.getByRole('button', { name: 'Save project event settings' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(fake.writePolicy).toHaveBeenCalledTimes(1)

    settle({
      ok: false,
      ownerHostId: 'owner',
      repoId: 'repo',
      reason: 'invalid-policy',
      message: 'agentId: bad'
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/host rejected/))
  })

  it.each([null, '', 'removed-agent'])(
    'cannot enable a policy without a valid Agent (%s), but can disable it',
    async (agentId) => {
      fake.readPolicy.mockResolvedValue({
        ...policyView(),
        policy: policy({ enabled: true, agentId })
      })
      render(
        <ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />
      )
      await screen.findByLabelText('Rules')
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Save project event settings' })
          .disabled
      ).toBe(true)
      fireEvent.click(screen.getByRole('switch'))
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Save project event settings' })
          .disabled
      ).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Save project event settings' }))
      await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(1))
      expect(fake.writePolicy.mock.calls[0]?.[3]).toMatchObject({
        enabled: false,
        agentId,
        model: null
      })
    }
  )

  it('validates the merged Enable overrides without preventing a disabling override', async () => {
    fake.readPolicy.mockResolvedValue({
      ...policyView(),
      policy: policy({ enabled: true, agentId: null })
    })
    fake.writePolicy.mockResolvedValue({
      ok: true,
      ownerHostId: 'owner',
      repoId: 'repo',
      generation: 4,
      policy: policy({ enabled: false, generation: 4 })
    })
    const { result } = renderHook(() =>
      useProjectEventAgentSettings({ repoId: 'repo', target: TARGET })
    )
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(async () => expect(await result.current.save({ enabled: true })).toBe(false))
    expect(fake.writePolicy).not.toHaveBeenCalled()
    await act(async () => expect(await result.current.save({ enabled: false })).toBe(true))
    expect(fake.writePolicy.mock.calls[0]?.[3]).toMatchObject({
      enabled: false,
      agentId: null,
      model: null
    })
  })

  it('blocks saving a project whose automatic analysis needs an agent and a model', async () => {
    fake.readPolicy.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      policy: policy({ automaticAnalysis: true, agentId: 'claude', model: null }),
      binding: null
    })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/choose an agent/))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save project event settings' })
        .disabled
    ).toBe(true)
  })

  it('warns only for an unencrypted secret and never calls an unrecorded one encrypted', async () => {
    fake.readPolicy.mockResolvedValue(
      policyView({ binding: binding({ secretProtection: 'plaintext' }) })
    )
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unencrypted/))
    cleanup()

    fake.readPolicy.mockResolvedValue(
      policyView({ binding: binding({ secretProtection: 'sealed' }) })
    )
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)
    await waitFor(() => expect(screen.getByText(/Stored encrypted/)).toBeTruthy())
    cleanup()

    fake.readPolicy.mockResolvedValue(policyView({ binding: binding({ secretProtection: null }) }))
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)
    await waitFor(() => expect(screen.getByText(/was not recorded/)).toBeTruthy())
    expect(screen.queryByText(/Stored encrypted/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says a staged rotation is not confirmed instead of claiming it already rotated', async () => {
    fake.readPolicy.mockResolvedValue(policyView({ binding: binding({ rotationPending: true }) }))
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText(/has not confirmed/)).toBeTruthy())
    expect(screen.queryByText(/has been rotated/i)).toBeNull()
  })

  it('renders recent activity without inventing an iid or a title', async () => {
    fake.readActivity.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      events: [
        {
          id: 1,
          kind: 'merge_request',
          iid: null,
          title: '',
          occurredAt: Date.now() - 60_000,
          outcome: 'unknown',
          errorCode: null
        }
      ],
      lastProcessed: null
    })
    fake.readPolicy.mockResolvedValue(policyView({ binding: binding() }))
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText('Merge request')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText(/Status unknown/)).toBeTruthy()
    expect(screen.getByText(/none yet/)).toBeTruthy()
  })

  it('shows the empty activity state when no event has arrived', async () => {
    fake.readPolicy.mockResolvedValue(policyView({ binding: binding() }))
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByText(/No events received yet/)).toBeTruthy())
  })

  it('sends unprotected storage only after the second, explicit confirmation', async () => {
    fake.readPolicy.mockResolvedValue(policyView({ binding: binding() }))
    fake.rotate
      .mockResolvedValueOnce({
        ok: false,
        ownerHostId: 'owner',
        repoId: 'repo',
        binding: binding({ state: 'failed' }),
        code: 'unprotected-storage',
        retryable: false
      })
      .mockResolvedValueOnce({
        ok: true,
        ownerHostId: 'owner',
        repoId: 'repo',
        binding: binding()
      })
    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={updateRepo} forceVisible />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate now' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Rotate now' }))

    await waitFor(() => expect(fake.rotate).toHaveBeenCalledTimes(1))
    expect(fake.rotate.mock.calls[0]?.[2]).toEqual({})

    const consent = await waitFor(() => screen.getByRole('checkbox'))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Rotate with unencrypted storage' })
        .disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate with unencrypted storage' }))
    expect(fake.rotate).toHaveBeenCalledTimes(1)

    fireEvent.click(consent)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate with unencrypted storage' }))
    await waitFor(() => expect(fake.rotate).toHaveBeenCalledTimes(2))
    expect(fake.rotate.mock.calls[1]?.[2]).toEqual({ allowUnprotectedStorage: true })
  })

  it('saves a folder project, re-runs the binding, and shows what the host resolved', async () => {
    fake.readPolicy.mockResolvedValueOnce(policyView())
    fake.readPolicy.mockResolvedValue(
      policyView({ binding: binding({ gitlabPath: 'group/folder' }) })
    )
    fake.retry.mockResolvedValue({
      ok: true,
      ownerHostId: 'owner',
      repoId: 'repo',
      binding: binding({ gitlabPath: 'group/folder' })
    })
    render(
      <ProjectEventAgentSettingsSection
        repo={repo({ kind: 'folder', path: '/notes' })}
        updateRepo={updateRepo}
        forceVisible
      />
    )

    await waitFor(() => expect(screen.getByText('Agent')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('GitLab project'), {
      target: { value: '  https://gitlab.test:8929/group/folder  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save GitLab project' }))

    await waitFor(() =>
      expect(updateRepo).toHaveBeenCalledWith('repo', {
        projectEventGitlabProject: 'https://gitlab.test:8929/group/folder'
      })
    )
    await waitFor(() => expect(fake.retry).toHaveBeenCalledWith('owner', 'repo', TARGET))
    await waitFor(() => expect(screen.getByText(/group\/folder/)).toBeTruthy())
  })

  it('explains a rejected folder project without echoing the host code', async () => {
    fake.readPolicy.mockResolvedValue(policyView())
    fake.retry.mockResolvedValue({
      ok: false,
      ownerHostId: 'owner',
      repoId: 'repo',
      binding: null,
      code: 'not-gitlab',
      retryable: false
    })
    render(
      <ProjectEventAgentSettingsSection
        repo={repo({ kind: 'folder', path: '/notes' })}
        updateRepo={updateRepo}
        forceVisible
      />
    )

    await waitFor(() => expect(screen.getByText('Agent')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('GitLab project'), {
      target: { value: 'not a url' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save GitLab project' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /does not see the address as a GitLab project/
      )
    )
    expect(screen.queryByText(/not-gitlab/)).toBeNull()
  })
})
