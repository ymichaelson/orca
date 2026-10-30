// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as LocalRuntimeCapabilities from '@/runtime/local-runtime-capabilities'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectEventPolicyView } from '../../../../shared/forge-inbox-project-event-policy'
import { forgeProjectPolicyPatchSchema } from '../../../../shared/forge-inbox-project-policy-patch'
import { projectEventDecisionSettingsSchema } from '../../../../shared/project-event-decision-settings'
import {
  DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS,
  parseProjectEventReceiverSettings
} from '../../../../shared/project-event-receiver-settings'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../shared/detected-worktree-provider-contract'
import type {
  DirectSshWorktreeFetchOptions,
  WorktreeFetchOptions
} from '@/store/slices/worktree-helpers'
import AddRepoDialog from './AddRepoDialog'

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  slug: vi.fn(),
  cloned: vi.fn(),
  completed: vi.fn(),
  supports: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClient>()),
  callRuntimeRpc: fake.rpc,
  runtimeEnvironmentSupportsCapability: fake.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', async (original) => ({
  ...(await original<typeof LocalRuntimeCapabilities>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [],
  ensureLocalRuntimeCapabilities: async () => [
    'forge-inbox.project-event-agent.v1',
    'project-events.decision-settings.v1',
    'project-events.receiver-settings.v1'
  ]
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: [], isLoading: false })
}))

const initial = useAppStore.getState()
type AppStoreState = typeof initial
const REMOTE = { kind: 'environment', environmentId: 'server-a' } as const
const policies = new Map<string, ProjectEventPolicyView>()
let decisionReady = true
let receiverReady = true
let receiverSettings = { ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS }

function repository(executionHostId: 'local' | 'runtime:server-a'): Repo {
  return {
    id: 'same-repo',
    path: executionHostId === 'local' ? '/local/repo' : '/srv/repo',
    displayName: executionHostId === 'local' ? 'Local twin' : 'Remote project',
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId
  }
}

function fetchWorktreesThen(onFetch: () => void): AppStoreState['fetchWorktrees'] {
  function fetchWorktrees(
    repoId: string,
    options: DirectSshWorktreeFetchOptions
  ): Promise<HostQualifiedDetectedWorktreeResult>
  function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  async function fetchWorktrees(): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    onFetch()
    return false
  }
  return fetchWorktrees
}

function policy(): ProjectEventPolicyView {
  return {
    repoId: 'same-repo',
    generation: 0,
    enabled: false,
    agentId: null,
    model: null,
    rules: 'Original rules',
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
    }
  }
}

function management(ownerHostId: string) {
  return {
    ownerHostId,
    protection: 'available',
    settings: {
      provider: 'jev',
      model: '',
      baseUrl: '',
      apiKeysSaved: { jev: decisionReady, laya: false }
    }
  }
}

const writeSchema = z.object({
  ownerHostId: z.string(),
  repoId: z.string(),
  expectedGeneration: z.number(),
  patch: forgeProjectPolicyPatchSchema
})
beforeEach(() => {
  vi.clearAllMocks()
  decisionReady = true
  fake.supports.mockResolvedValue(true)
  receiverReady = true
  receiverSettings = { ...DEFAULT_PROJECT_EVENT_RECEIVER_SETTINGS }
  policies.clear()
  policies.set('local', policy())
  policies.set('server-a', policy())
  useAppStore.setState(initial, true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/fake-home'), activeRuntimeEnvironmentId: 'server-a' },
    repos: [repository('local')],
    runtimeEnvironments: [
      {
        id: 'server-a',
        name: 'Build server',
        endpoints: [],
        preferredEndpointId: 'endpoint',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null
      }
    ],
    runtimeStatusByEnvironmentId: new Map([
      [
        'server-a',
        {
          checkedAt: 0,
          status: {
            runtimeId: 'rt',
            rendererGraphEpoch: 0,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 3
          }
        }
      ]
    ]),
    fetchWorktrees: fetchWorktreesThen(() => {})
  })
  Object.assign(window, {
    api: {
      repos: { cloneAbort: async () => {}, onCloneProgress: () => () => {} },
      gl: { projectSlug: fake.slug }
    }
  })
  fake.slug.mockResolvedValue(null)
  fake.rpc.mockImplementation(
    async (target: { kind: string; environmentId?: string }, method: string, input: unknown) => {
      const host = target.kind === 'environment' ? (target.environmentId ?? 'invalid') : 'local'
      const ownerHostId = `owner-${host}`
      switch (method) {
        case 'repo.clone':
          fake.cloned()
          return { repo: repository('runtime:server-a') }
        case 'forgeInbox.getStatus':
        case 'forgeInbox.retryReceiver':
          return {
            ownerHostId,
            available: true,
            phase: 'running',
            listener: {
              enabled: receiverSettings.enabled,
              listening: receiverSettings.enabled,
              port: receiverSettings.port,
              error: null
            }
          }
        case 'settings.get':
          return { settings: { projectEventReceiver: receiverSettings } }
        case 'settings.update': {
          receiverSettings = parseProjectEventReceiverSettings(
            z.object({ projectEventReceiver: z.unknown() }).parse(input).projectEventReceiver
          )
          receiverReady = receiverSettings.enabled && receiverSettings.externalBaseUrl !== ''
          return { settings: { projectEventReceiver: receiverSettings } }
        }
        case 'forgeInbox.getProjectEventPolicy':
          return { ownerHostId, repoId: 'same-repo', policy: policies.get(host), binding: null }
        case 'agentSession.modelCatalog': {
          const { agent } = z.object({ agent: z.string() }).parse(input)
          const id = host === 'server-a' ? 'owner-model' : 'local-only-model'
          return agent === 'codex'
            ? {
                origin: 'probe',
                fetchedAt: 1,
                models: [{ id, label: id, isDefault: false, efforts: [] }]
              }
            : { origin: 'unknown' }
        }
        case 'forgeInbox.getProjectEventActivity':
          return { ownerHostId, repoId: 'same-repo', events: [], lastProcessed: null }
        case 'forgeInbox.updateProjectEventPolicy': {
          const request = writeSchema.parse(input)
          expect(request.ownerHostId).toBe(ownerHostId)
          const saved = policies.get(host)
          if (!saved) {
            throw new Error('Missing owner policy')
          }
          expect(request.expectedGeneration).toBe(saved.generation)
          const next = {
            ...saved,
            ...request.patch,
            events: saved.events,
            budgets: saved.budgets,
            generation: saved.generation + 1
          }
          policies.set(host, next)
          return {
            ok: true,
            ownerHostId,
            repoId: 'same-repo',
            generation: next.generation,
            policy: next
          }
        }
        case 'projectEventDecision.getSettings':
          return management(ownerHostId)
        case 'projectEventDecision.saveApiKey': {
          const saved = z
            .object({
              ownerHostId: z.string(),
              provider: z.literal('jev'),
              apiKey: z.literal('fake-owner-key')
            })
            .parse(input)
          expect(saved.ownerHostId).toBe(ownerHostId)
          decisionReady = true
          return management(ownerHostId)
        }
        case 'projectEventDecision.saveSettings':
          projectEventDecisionSettingsSchema.parse(
            z.object({ settings: z.unknown() }).parse(input).settings
          )
          return management(ownerHostId)
        case 'forgeInbox.retryProjectEvent':
          return receiverReady
            ? {
                ok: true,
                ownerHostId,
                repoId: 'same-repo',
                binding: { gitlabHost: 'gitlab.test', gitlabPath: 'group/remote' }
              }
            : { ok: false, ownerHostId, repoId: 'same-repo', code: 'receiver-not-configured' }
        default:
          throw new Error(`Unexpected fake RPC: ${method}`)
      }
    }
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

async function cloneRemote(): Promise<void> {
  render(
    <TooltipProvider>
      <AddRepoDialog
        hosted={{ open: true, onOpenChange: () => {}, onProjectAdded: fake.completed }}
      />
    </TooltipProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: /Clone from URL/ }))
  fireEvent.change(screen.getByPlaceholderText('https://github.com/user/repo.git'), {
    target: { value: 'https://gitlab.test/group/remote.git' }
  })
  fireEvent.change(screen.getByPlaceholderText('/home/user/projects'), {
    target: { value: '/srv' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
}

async function chooseAgent(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Agent'))
  fireEvent.click(await screen.findByRole('option', { name: /Codex/ }))
}

async function returnToSetup(): Promise<void> {
  const back = screen.getByRole<HTMLButtonElement>('button', { name: 'Back to project setup' })
  await waitFor(() => expect(back.disabled).toBe(false))
  fireEvent.click(back)
}

describe('Add Project root owner and prerequisites', () => {
  it('uses the captured remote owner when a local repository has the same id', async () => {
    await cloneRemote()
    expect(await screen.findByText('Project added: Remote project')).toBeTruthy()
    expect(fake.slug).not.toHaveBeenCalled()
    await chooseAgent()
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Remote rules only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    expect(policies.get('server-a')).toMatchObject({
      enabled: true,
      agentId: 'codex',
      model: null,
      rules: 'Remote rules only'
    })
    expect(policies.get('local')).toEqual(policy())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(fake.cloned).toHaveBeenCalledTimes(1)
  })

  it('offers the owner host’s models and saves the chosen one with the policy', async () => {
    await cloneRemote()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.click(screen.getByLabelText('Model'))
    expect(await screen.findByRole('option', { name: 'owner-model' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'local-only-model' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'owner-model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    expect(policies.get('server-a')).toMatchObject({ agentId: 'codex', model: 'owner-model' })
    expect(policies.get('local')).toEqual(policy())
    expect(
      fake.rpc.mock.calls
        .filter(([, method]) => method === 'agentSession.modelCatalog')
        .every(([target]) => target.kind === 'environment' && target.environmentId === 'server-a')
    ).toBe(true)
  })

  it.each(['missing', 'ambiguous'])(
    'completes once without guessing a %s owner after the repository refresh',
    async (kind) => {
      useAppStore.setState({
        fetchWorktrees: fetchWorktreesThen(() => {
          useAppStore.setState((state) => ({
            repos:
              kind === 'missing'
                ? state.repos.filter((repo) => repo.executionHostId === 'local')
                : [
                    ...state.repos,
                    { ...repository('runtime:server-a'), connectionId: 'nested-ssh' }
                  ]
          }))
        })
      })
      await cloneRemote()
      await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
      expect(screen.queryByText('Project added: Local twin')).toBeNull()
      expect(fake.slug).not.toHaveBeenCalled()
      expect(policies.get('local')).toEqual(policy())
      expect(policies.get('server-a')).toEqual(policy())
      expect(fake.cloned).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps unsupported decision metadata honest and never substitutes local configuration', async () => {
    useAppStore.setState({ repos: [] })
    fake.supports.mockImplementation(
      async (_host: string, capability: string) =>
        capability !== 'project-events.decision-settings.v1'
    )
    await cloneRemote()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Enable project event agent' }).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Set up decision model' }))
    await screen.findByText(
      'This host does not support event decision settings. Update the host and retry.'
    )
    expect(fake.rpc.mock.calls.some(([target]) => target.kind === 'local')).toBe(false)
    await returnToSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
  })

  it('explains why Enable is disabled until an Agent is chosen', async () => {
    useAppStore.setState({ repos: [] })
    await cloneRemote()
    await screen.findByLabelText('Rules')
    const enable = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Enable project event agent'
    })
    expect(enable.disabled).toBe(true)
    const message = 'Choose an existing agent before enabling project events.'
    expect(screen.getByText(message).getAttribute('role')).toBe('status')
    await chooseAgent()
    expect(screen.queryByText(message)).toBeNull()
    expect(enable.disabled).toBe(false)
  })

  it('cannot enable without an Agent, but independent Skip completes the clone once', async () => {
    useAppStore.setState({ repos: [] })
    await cloneRemote()
    await screen.findByLabelText('Rules')
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Enable project event agent' }).disabled
    ).toBe(true)
    const skip = screen.getByRole('button', { name: 'Skip for now' })
    fireEvent.click(skip)
    fireEvent.click(skip)
    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(fake.cloned).toHaveBeenCalledTimes(1)
    expect(policies.get('server-a')?.enabled).toBe(false)
  })

  it('configures the owner receiver in the same flow, retaining all entries and retrying only connection', async () => {
    useAppStore.setState({ repos: [] })
    receiverReady = false
    await cloneRemote()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Receiver draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Integrations settings' }))
    expect(await screen.findByText('Event receiver on Build server')).toBeTruthy()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable event receiver' }))
    fireEvent.change(screen.getByLabelText('External base URL'), {
      target: { value: 'https://receiver.test' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook settings' }))
    await waitFor(() => expect(receiverReady).toBe(true))
    await returnToSetup()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Receiver draft')
    expect(screen.getByLabelText('Model').textContent).toBe('Agent default')
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    expect(
      fake.rpc.mock.calls.filter(([, method]) => method === 'forgeInbox.updateProjectEventPolicy')
    ).toHaveLength(1)
    expect(policies.get('local')).toEqual(policy())
    expect(fake.completed).not.toHaveBeenCalled()
    expect(fake.cloned).toHaveBeenCalledTimes(1)
  })

  it('configures the decision model on the owner and returns to the exact draft without recloning', async () => {
    useAppStore.setState({ repos: [] })
    decisionReady = false
    await cloneRemote()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(await screen.findByRole('option', { name: 'Custom model…' }))
    fireEvent.change(screen.getByLabelText('Custom model name'), {
      target: { value: 'custom-agent-model' }
    })
    fireEvent.change(screen.getByLabelText('Rules'), {
      target: { value: 'Keep this exact draft\n第二行' }
    })
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Enable project event agent' }).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Set up decision model' }))
    expect(
      await screen.findByText('Quick decisions for project event agents on Build server')
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fake-owner-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await screen.findByText(/A key is saved on this host. It is never shown again/)
    await returnToSetup()
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Enable project event agent' })
          .disabled
      ).toBe(false)
    )
    expect(screen.getByLabelText<HTMLInputElement>('Custom model name').value).toBe(
      'custom-agent-model'
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe(
      'Keep this exact draft\n第二行'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    expect(policies.get('server-a')).toMatchObject({
      agentId: 'codex',
      model: 'custom-agent-model',
      rules: 'Keep this exact draft\n第二行',
      enabled: true
    })
    expect(policies.get('local')).toEqual(policy())
    expect(fake.cloned).toHaveBeenCalledTimes(1)
    expect(
      fake.rpc.mock.calls
        .filter(([, method]) => String(method).startsWith('projectEventDecision.'))
        .every(([target]) => JSON.stringify(target) === JSON.stringify(REMOTE))
    ).toBe(true)
  })
})
