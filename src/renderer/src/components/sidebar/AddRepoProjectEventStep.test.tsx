// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { ProjectEventBindingView } from '../../../../shared/forge-inbox-project-binding'
import type { ProjectEventPolicyView } from '../../../../shared/forge-inbox-project-event-policy'
import { DEFAULT_PROJECT_EVENT_RULES } from '../../../../shared/project-event-default-rules'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ProjectEventAgentSettingsSection } from '../settings/ProjectEventAgentSettingsSection'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { AddRepoProjectEventStep } from './AddRepoProjectEventStep'
import { useAddRepoProjectEventSetup } from './use-add-repo-project-event-setup'

const fake = vi.hoisted(() => ({
  status: vi.fn(),
  readPolicy: vi.fn(),
  writePolicy: vi.fn(),
  readActivity: vi.fn(),
  retry: vi.fn(),
  supports: vi.fn(),
  capabilities: vi.fn(),
  projectSlug: vi.fn(),
  decision: vi.fn(),
  openSettingsTarget: vi.fn(),
  modelCatalog: vi.fn()
}))
const store = vi.hoisted(
  (): { settingsSearchQuery: string; repos: Repo[]; openSettingsTarget: () => void } => ({
    settingsSearchQuery: '',
    repos: [],
    openSettingsTarget: () => {}
  })
)

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
  rotateProjectEventSecret: vi.fn()
}))
vi.mock('@/runtime/project-event-decision-settings-client', () => ({
  callProjectEventDecisionSettings: fake.decision,
  testProjectEventDecisionConnection: vi.fn()
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
const SERVER_A = { kind: 'environment', environmentId: 'server-a' } as const
const SERVER_B = { kind: 'environment', environmentId: 'server-b' } as const

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
    agentId: 'claude',
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

function writeOk(next: Partial<ProjectEventPolicyView> = {}) {
  return {
    ok: true as const,
    ownerHostId: 'owner',
    repoId: 'repo',
    generation: 4,
    policy: policy({ generation: 4, enabled: true, rules: DEFAULT_PROJECT_EVENT_RULES, ...next })
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Dialog open>
      <DialogContent>{children}</DialogContent>
    </Dialog>
  )
}

type CompleteGitRepoAdd = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId
) => Promise<void>

function Harness({ complete, startAdd }: { complete: CompleteGitRepoAdd; startAdd: () => void }) {
  const [step, setStep] = useState<AddRepoDialogStep>('add')
  const setup = useAddRepoProjectEventSetup({
    completeGitRepoAdd: complete,
    setStep
  })
  return (
    <Frame>
      <span data-testid="step">{step}</span>
      <button
        type="button"
        onClick={() => {
          startAdd()
          void setup.onGitRepoReady('repo', 'clone_url', getRepoExecutionHostId(store.repos[0]))
        }}
      >
        add
      </button>
      <button type="button" onClick={() => setup.requestDismiss()}>
        dismiss
      </button>
      {setup.step ? <AddRepoProjectEventStep {...setup.step} /> : null}
    </Frame>
  )
}

let complete = vi.fn<CompleteGitRepoAdd>()
let startAdd = vi.fn<() => void>()

function renderHarness(): void {
  render(<Harness complete={complete} startAdd={startAdd} />)
}

async function openStep(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'add' }))
  await waitFor(() => expect(screen.getByLabelText('Rules')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Agent'))
  fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))
}

async function chooseModel(model: string): Promise<void> {
  fireEvent.click(screen.getByLabelText('Model'))
  fireEvent.click(await screen.findByRole('option', { name: model }))
}

beforeEach(() => {
  vi.resetAllMocks()
  fake.modelCatalog.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 1,
    models: ['sonnet', 'opus'].map((id) => ({ id, label: id, isDefault: false, efforts: [] }))
  })
  store.repos = [repo()]
  store.openSettingsTarget = fake.openSettingsTarget
  complete = vi.fn<CompleteGitRepoAdd>().mockResolvedValue(undefined)
  startAdd = vi.fn<() => void>()
  fake.decision.mockResolvedValue({
    ownerHostId: 'owner',
    protection: 'available',
    settings: { provider: 'jev', model: '', baseUrl: '', apiKeysSaved: { jev: true, laya: false } }
  })
  fake.capabilities.mockResolvedValue([CAPABILITY, 'project-events.decision-settings.v1'])
  fake.supports.mockResolvedValue(true)
  fake.status.mockResolvedValue({ ownerHostId: 'owner', available: true, phase: 'running' })
  fake.readPolicy.mockResolvedValue({
    ownerHostId: 'owner',
    repoId: 'repo',
    policy: null,
    binding: null
  })
  fake.readActivity.mockResolvedValue({
    ownerHostId: 'owner',
    repoId: 'repo',
    events: [],
    lastProcessed: null
  })
  Object.assign(window, { api: { gl: { projectSlug: fake.projectSlug } } })
})
afterEach(cleanup)

describe('Add Project event agent step', () => {
  it('holds the final completion until the user resolves the step, then completes once', async () => {
    renderHarness()
    await openStep()

    expect(screen.getByTestId('step').textContent).toBe('project-event')
    expect(screen.getByText('Project added: Alpha')).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()

    const skip = screen.getByRole('button', { name: 'Skip for now' })
    fireEvent.click(skip)
    fireEvent.click(skip)

    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete).toHaveBeenCalledWith('repo', 'clone_url', 'runtime:server-a')
    expect(fake.writePolicy).not.toHaveBeenCalled()
    expect(fake.retry).not.toHaveBeenCalled()
  })

  it('saves the entered policy on the owner host and shows the connection result', async () => {
    fake.writePolicy.mockResolvedValue(writeOk({ rules: 'Be brief.', model: 'sonnet' }))
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: true,
      binding: binding()
    })
    renderHarness()
    await openStep()

    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe(
      DEFAULT_PROJECT_EVENT_RULES
    )
    await chooseModel('sonnet')
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Be brief.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))

    await waitFor(() => expect(screen.getByText(/connected to GitLab project/)).toBeTruthy())
    expect(fake.writePolicy).toHaveBeenCalledWith(
      'owner',
      'repo',
      0,
      { enabled: true, agentId: 'claude', model: 'sonnet', rules: 'Be brief.' },
      SERVER_A
    )
    expect(fake.retry).toHaveBeenCalledWith('owner', 'repo', SERVER_A)
    expect(complete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  })

  it('keeps the repo and the entered rules when the policy save fails, then retries only the save', async () => {
    fake.writePolicy.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(writeOk())
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: true,
      binding: binding()
    })
    renderHarness()
    await openStep()

    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'My rules.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))

    await waitFor(() => expect(screen.getByText(/settings were not saved/)).toBeTruthy())
    expect(screen.getByText('Project added: Alpha')).toBeTruthy()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('My rules.')
    expect(fake.retry).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText(/connected to GitLab project/)).toBeTruthy())
    expect(fake.writePolicy).toHaveBeenCalledTimes(2)
    expect(fake.writePolicy.mock.calls[1]?.[3]).toMatchObject({ rules: 'My rules.' })
    expect(startAdd).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports saved settings and a failed webhook as separate outcomes and retries only the connection', async () => {
    fake.writePolicy.mockResolvedValue(writeOk())
    fake.retry
      .mockResolvedValueOnce({
        ownerHostId: 'owner',
        repoId: 'repo',
        ok: false,
        binding: null,
        code: 'receiver-not-configured'
      })
      .mockResolvedValueOnce({ ownerHostId: 'owner', repoId: 'repo', ok: true, binding: binding() })
    renderHarness()
    await openStep()

    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Keep me.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))

    await waitFor(() => expect(screen.getByText(/webhook is not connected/)).toBeTruthy())
    expect(screen.getByText(/inbox receiver is not configured/)).toBeTruthy()
    expect(screen.getByText('Project added: Alpha')).toBeTruthy()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Keep me.')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText(/connected to GitLab project/)).toBeTruthy())
    expect(fake.writePolicy).toHaveBeenCalledTimes(1)
    expect(fake.retry).toHaveBeenCalledTimes(2)
    expect(startAdd).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
  })

  it.each(['not-gitlab', 'no-git-remote'])(
    'treats %s as a neutral answer and switches the saved policy back off',
    async (code) => {
      fake.writePolicy
        .mockResolvedValueOnce(writeOk({ rules: 'Keep.' }))
        .mockResolvedValueOnce(writeOk({ enabled: false, generation: 5, rules: 'Keep.' }))
      fake.retry.mockResolvedValue({
        ownerHostId: 'owner',
        repoId: 'repo',
        ok: false,
        binding: null,
        code
      })
      renderHarness()
      await openStep()

      fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Keep.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))

      await waitFor(() => expect(screen.getByText(/has no GitLab project to connect/)).toBeTruthy())
      expect(fake.writePolicy).toHaveBeenCalledTimes(2)
      expect(fake.writePolicy.mock.calls[1]?.[2]).toBe(4)
      expect(fake.writePolicy.mock.calls[1]?.[3]).toEqual({
        enabled: false,
        agentId: 'claude',
        model: null,
        rules: 'Keep.'
      })
      expect(screen.getByText(/left off/)).toBeTruthy()
      expect(screen.queryByText(/not connected/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(complete).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    }
  )

  it('says so when the policy for a repository without GitLab cannot be switched back off', async () => {
    fake.writePolicy.mockResolvedValueOnce(writeOk()).mockRejectedValueOnce(new Error('offline'))
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: false,
      binding: null,
      code: 'not-gitlab'
    })
    renderHarness()
    await openStep()

    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))

    await waitFor(() => expect(screen.getByText(/could not be switched back off/)).toBeTruthy())
    expect(screen.queryByText(/left off/)).toBeNull()
    expect(screen.getByText('Project added: Alpha')).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
  })

  it('treats dismissing the dialog as continuing without the event agent', async () => {
    renderHarness()
    await openStep()

    const dismiss = screen.getByRole('button', { name: 'dismiss' })
    fireEvent.click(dismiss)
    fireEvent.click(dismiss)
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(complete).toHaveBeenCalledTimes(1)
    expect(fake.writePolicy).not.toHaveBeenCalled()
  })

  it('ignores a dismiss while the policy save is still in flight', async () => {
    let settle: (value: ReturnType<typeof writeOk>) => void = () => {}
    fake.writePolicy.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: true,
      binding: binding()
    })
    renderHarness()
    await openStep()

    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
    await act(async () => {})
    expect(complete).not.toHaveBeenCalled()

    await act(async () => {
      settle(writeOk())
    })
    await waitFor(() => expect(screen.getByText(/connected to GitLab project/)).toBeTruthy())
    expect(complete).not.toHaveBeenCalled()
  })

  it('completes straight away for a folder workspace', async () => {
    store.repos = [repo({ kind: 'folder' })]
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'add' }))

    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('Rules')).toBeNull()
    expect(screen.getByTestId('step').textContent).toBe('add')
    expect(fake.status).not.toHaveBeenCalled()
  })

  it('completes straight away for a local repository the host does not see as GitLab', async () => {
    store.repos = [repo({ executionHostId: 'local' })]
    fake.projectSlug.mockResolvedValue(null)
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'add' }))

    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('Rules')).toBeNull()
    expect(fake.capabilities).not.toHaveBeenCalled()
  })

  it('offers the step for a local GitLab repository and routes the policy to this computer', async () => {
    store.repos = [repo({ executionHostId: 'local' })]
    fake.projectSlug.mockResolvedValue({ host: 'gitlab.test', path: 'group/demo' })
    fake.writePolicy.mockResolvedValue(writeOk())
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: true,
      binding: binding()
    })
    renderHarness()
    await openStep()

    expect(fake.projectSlug).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', repoId: 'repo' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    await waitFor(() => expect(screen.getByText(/connected to GitLab project/)).toBeTruthy())
    expect(fake.writePolicy.mock.calls[0]?.[4]).toEqual({ kind: 'local' })
  })

  it('explains an unreachable owner and never calls the local policy path for it', async () => {
    store.repos = [repo({ executionHostId: null, connectionId: 'dev-box' })]
    fake.projectSlug.mockResolvedValue({ host: 'gitlab.test', path: 'group/demo' })
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'add' }))

    await waitFor(() => expect(screen.getByText(/cannot reach directly/)).toBeTruthy())
    expect(screen.getByText('Project added: Alpha')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable project event agent' })).toBeNull()
    expect(fake.capabilities).not.toHaveBeenCalled()
    expect(fake.status).not.toHaveBeenCalled()
    expect(fake.readPolicy).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  })

  it('does not probe this computer to guess whether a direct SSH repository is GitLab', async () => {
    store.repos = [repo({ executionHostId: null, connectionId: 'dev-box' })]
    fake.projectSlug.mockResolvedValue(null)
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'add' }))

    await screen.findByText(/cannot reach directly/)
    expect(fake.projectSlug).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  })

  it('says the host build is too old instead of offering fields it cannot save', async () => {
    fake.supports.mockResolvedValue(false)
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'add' }))

    await waitFor(() => expect(screen.getByText(/older Orca build/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Enable project event agent' })).toBeNull()
    expect(fake.readPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  })

  it('does not let a slow answer from the previous host overwrite the current draft', async () => {
    let settleA: (value: unknown) => void = () => {}
    fake.readPolicy.mockImplementation(
      (_owner: string, _repoId: string, target: { environmentId: string }) =>
        target.environmentId === 'server-a'
          ? new Promise((resolve) => {
              settleA = resolve
            })
          : Promise.resolve({
              ownerHostId: 'owner',
              repoId: 'repo',
              policy: policy({ rules: 'Rules from B.' }),
              binding: null
            })
    )
    const props = {
      onContinue: vi.fn().mockResolvedValue(true),
      onOpenSettings: vi.fn().mockResolvedValue(true),
      onBusyChange: vi.fn()
    }
    const view = render(
      <Frame>
        <AddRepoProjectEventStep repo={repo()} target={SERVER_A} {...props} />
      </Frame>
    )
    await waitFor(() => expect(fake.readPolicy).toHaveBeenCalledTimes(1))

    view.rerender(
      <Frame>
        <AddRepoProjectEventStep
          repo={repo({ executionHostId: 'runtime:server-b' })}
          target={SERVER_B}
          {...props}
        />
      </Frame>
    )
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Rules from B.')
    )
    await act(async () => {
      settleA({
        ownerHostId: 'owner',
        repoId: 'repo',
        policy: policy({ rules: 'Rules from A.' }),
        binding: null
      })
    })

    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Rules from B.')
  })
})

describe('Add Project step and project settings share one editor', () => {
  it('sends the same policy fields for the same edits', async () => {
    fake.writePolicy.mockResolvedValue(writeOk())
    fake.retry.mockResolvedValue({
      ownerHostId: 'owner',
      repoId: 'repo',
      ok: true,
      binding: binding()
    })
    const edit = async (): Promise<void> => {
      await chooseModel('opus')
      fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Shared rules.' } })
    }

    render(<ProjectEventAgentSettingsSection repo={repo()} updateRepo={vi.fn()} forceVisible />)
    await waitFor(() => expect(screen.getByLabelText('Rules')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByLabelText('Agent'))
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))
    await edit()
    fireEvent.click(screen.getByRole('button', { name: 'Save project event settings' }))
    await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(1))
    cleanup()

    renderHarness()
    await openStep()
    await edit()
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    await waitFor(() => expect(fake.writePolicy).toHaveBeenCalledTimes(2))

    expect(fake.writePolicy.mock.calls[1]?.[3]).toEqual(fake.writePolicy.mock.calls[0]?.[3])
  })
})
