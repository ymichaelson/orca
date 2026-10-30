// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import type { HostQualifiedDetectedWorktreeResult } from '../../../../shared/detected-worktree-provider-contract'
import type {
  DirectSshWorktreeFetchOptions,
  WorktreeFetchOptions
} from '@/store/slices/worktree-helpers'
import AddRepoDialog from './AddRepoDialog'

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  slug: vi.fn(),
  add: vi.fn(),
  pickFolders: vi.fn(),
  scanNested: vi.fn(),
  completed: vi.fn(),
  openChanged: vi.fn(),
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
const DISPLAY_NAMES: Record<string, string> = {
  alpha: 'Alpha project',
  beta: 'Beta project',
  plain: 'Plain project',
  gitlab: 'GitLab project'
}
const policies = new Map<string, ProjectEventPolicyView>()
let receiverReady = true
let holdPolicyWriteFor: string | null = null
let releaseHeldPolicyWrite: (() => void) | null = null

function repositoryFor(path: string): Repo {
  const id = path.split('/').pop() ?? path
  return {
    id,
    path,
    displayName: DISPLAY_NAMES[id] ?? id,
    badgeColor: '',
    addedAt: 0,
    kind: 'git'
  }
}

function policyFor(repoId: string): ProjectEventPolicyView {
  return {
    repoId,
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

function scanFor(path: string): unknown {
  return {
    selectedPath: path,
    selectedPathKind: 'git_repo',
    repos: [],
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null
  }
}

function fetchWorktreesThen(): typeof initial.fetchWorktrees {
  function fetchWorktrees(
    repoId: string,
    options: DirectSshWorktreeFetchOptions
  ): Promise<HostQualifiedDetectedWorktreeResult>
  function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  async function fetchWorktrees(): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    return false
  }
  return fetchWorktrees
}

const writeSchema = z.object({
  ownerHostId: z.string(),
  repoId: z.string(),
  expectedGeneration: z.number(),
  patch: forgeProjectPolicyPatchSchema
})
const ownerSchema = z.object({ ownerHostId: z.string(), repoId: z.string() })

beforeEach(() => {
  vi.clearAllMocks()
  holdPolicyWriteFor = null
  releaseHeldPolicyWrite = null
  receiverReady = true
  policies.clear()
  fake.supports.mockResolvedValue(true)
  fake.add.mockImplementation(async ({ path }: { path: string }) => ({
    repo: repositoryFor(path)
  }))
  fake.pickFolders.mockResolvedValue([])
  fake.scanNested.mockImplementation(async ({ path }: { path: string }) => scanFor(path))
  // Every selected project is GitLab-linked except the plain one used for mixed batches.
  fake.slug.mockImplementation(async ({ repoId }: { repoId: string }) =>
    repoId === 'plain' ? null : { host: 'gitlab.test', path: `group/${repoId}` }
  )
  useAppStore.setState(initial, true)
  useAppStore.setState({
    settings: getDefaultSettings('/fake-home'),
    repos: [],
    runtimeEnvironments: [],
    fetchWorktrees: fetchWorktreesThen()
  })
  Object.assign(window, {
    api: {
      repos: {
        add: fake.add,
        pickFolders: fake.pickFolders,
        cloneAbort: async () => {},
        onCloneProgress: () => () => {}
      },
      projectGroups: {
        scanNested: fake.scanNested,
        onNestedScanProgress: () => () => {},
        cancelNestedScan: async () => true
      },
      gl: { projectSlug: fake.slug }
    }
  })
  fake.rpc.mockImplementation(async (target: { kind: string }, method: string, input: unknown) => {
    const ownerHostId = target.kind === 'environment' ? 'owner-invalid' : 'owner-local'
    switch (method) {
      case 'forgeInbox.getStatus':
      case 'forgeInbox.retryReceiver':
        return {
          ownerHostId,
          available: true,
          phase: 'running',
          listener: { enabled: true, listening: true, port: 1, error: null }
        }
      case 'forgeInbox.getProjectEventPolicy': {
        const request = ownerSchema.parse(input)
        expect(request.ownerHostId).toBe(ownerHostId)
        return {
          ownerHostId,
          repoId: request.repoId,
          policy: policies.get(request.repoId) ?? policyFor(request.repoId),
          binding: null
        }
      }
      case 'forgeInbox.getProjectEventActivity': {
        const request = ownerSchema.parse(input)
        return { ownerHostId, repoId: request.repoId, events: [], lastProcessed: null }
      }
      case 'forgeInbox.updateProjectEventPolicy': {
        const request = writeSchema.parse(input)
        expect(request.ownerHostId).toBe(ownerHostId)
        if (holdPolicyWriteFor === request.repoId) {
          await new Promise<void>((resolve) => {
            releaseHeldPolicyWrite = resolve
          })
        }
        const saved = policies.get(request.repoId) ?? policyFor(request.repoId)
        expect(request.expectedGeneration).toBe(saved.generation)
        const next = {
          ...saved,
          ...request.patch,
          events: saved.events,
          budgets: saved.budgets,
          generation: saved.generation + 1
        }
        policies.set(request.repoId, next)
        return {
          ok: true,
          ownerHostId,
          repoId: request.repoId,
          generation: next.generation,
          policy: next
        }
      }
      case 'forgeInbox.retryProjectEvent': {
        const request = ownerSchema.parse(input)
        return receiverReady
          ? {
              ok: true,
              ownerHostId,
              repoId: request.repoId,
              binding: { gitlabHost: 'gitlab.test', gitlabPath: `group/${request.repoId}` }
            }
          : {
              ok: false,
              ownerHostId,
              repoId: request.repoId,
              code: 'receiver-not-configured'
            }
      }
      case 'projectEventDecision.getSettings':
        return {
          ownerHostId,
          protection: 'available',
          settings: {
            provider: 'jev',
            model: '',
            baseUrl: '',
            apiKeysSaved: { jev: true, laya: false }
          }
        }
      default:
        throw new Error(`Unexpected fake RPC: ${method}`)
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

async function openBatch(...paths: string[]): Promise<void> {
  fake.pickFolders.mockResolvedValue(paths)
  render(
    <TooltipProvider>
      <AddRepoDialog
        hosted={{
          open: true,
          onOpenChange: fake.openChanged,
          onProjectAdded: fake.completed
        }}
      />
    </TooltipProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: /Browse folder/ }))
}

async function chooseAgent(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Agent'))
  fireEvent.click(await screen.findByRole('option', { name: /Codex/ }))
}

describe('Add Project batch project event setup', () => {
  it('gives both GitLab projects their own setup step and completes once at the end', async () => {
    await openBatch('/projects/alpha', '/projects/beta')

    expect(await screen.findByText('Project added: Alpha project')).toBeTruthy()
    expect(screen.queryByText('Project added: Beta project')).toBeNull()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Alpha rules only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Project added: Beta project')).toBeTruthy()
    expect(screen.queryByText('Project added: Alpha project')).toBeNull()
    expect(fake.completed).not.toHaveBeenCalled()

    await screen.findByLabelText('Rules')
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(fake.completed).toHaveBeenCalledWith('alpha')
    expect(fake.openChanged).toHaveBeenCalledTimes(1)
    expect(fake.openChanged).toHaveBeenCalledWith(false)
    expect(fake.add.mock.calls.map(([args]) => args.path)).toEqual([
      '/projects/alpha',
      '/projects/beta'
    ])
    expect(policies.get('alpha')).toMatchObject({
      enabled: true,
      agentId: 'codex',
      rules: 'Alpha rules only'
    })
    expect(policies.has('beta')).toBe(false)
  })

  it('does not rewrite the first project’s policy when the next project retries its connection', async () => {
    await openBatch('/projects/alpha', '/projects/beta')

    expect(await screen.findByText('Project added: Alpha project')).toBeTruthy()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Alpha rules only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    const alphaAfterConfigure = { ...policies.get('alpha') }

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Project added: Beta project')).toBeTruthy()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    receiverReady = false
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    expect(await screen.findByText(/GitLab webhook is not connected/)).toBeTruthy()
    receiverReady = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(policies.get('alpha')).toEqual(alphaAfterConfigure)
    expect(policies.get('alpha')?.generation).toBe(1)
    expect(policies.get('beta')).toMatchObject({
      enabled: true,
      agentId: 'codex',
      generation: 1
    })
  })

  it('offers one setup step for a mixed batch and completes once after skipping it', async () => {
    await openBatch('/projects/plain', '/projects/gitlab')

    expect(await screen.findByText('Project added: GitLab project')).toBeTruthy()
    expect(screen.queryByText('Project added: Plain project')).toBeNull()
    await screen.findByLabelText('Rules')
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(fake.completed).toHaveBeenCalledWith('plain')
    expect(fake.openChanged).toHaveBeenCalledTimes(1)
    expect(fake.add).toHaveBeenCalledTimes(2)
    expect(policies.has('gitlab')).toBe(false)
  })

  it('skips the remaining setup steps and completes once when dismissed between steps', async () => {
    const user = userEvent.setup()
    await openBatch('/projects/alpha', '/projects/beta')

    expect(await screen.findByText('Project added: Alpha project')).toBeTruthy()
    await screen.findByLabelText('Rules')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(fake.completed).toHaveBeenCalledWith('alpha')
    expect(fake.openChanged).toHaveBeenCalledTimes(1)
    expect(fake.openChanged).toHaveBeenCalledWith(false)
    expect(screen.queryByText('Project added: Beta project')).toBeNull()
    expect(fake.add).toHaveBeenCalledTimes(2)
    expect(policies.has('alpha')).toBe(false)
  })

  it('keeps the in-flight setup when the dialog is dismissed while it saves', async () => {
    const user = userEvent.setup()
    holdPolicyWriteFor = 'alpha'
    await openBatch('/projects/alpha', '/projects/beta')

    expect(await screen.findByText('Project added: Alpha project')).toBeTruthy()
    await screen.findByLabelText('Rules')
    await chooseAgent()
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: 'Kept draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable project event agent' }))
    const enable = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Enable project event agent'
    })
    await waitFor(() => expect(enable.disabled).toBe(true))
    await waitFor(() => expect(releaseHeldPolicyWrite).not.toBeNull())

    await user.keyboard('{Escape}')

    expect(screen.getByText('Project added: Alpha project')).toBeTruthy()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Rules').value).toBe('Kept draft')
    expect(fake.completed).not.toHaveBeenCalled()
    expect(fake.openChanged).not.toHaveBeenCalled()

    releaseHeldPolicyWrite?.()
    expect(await screen.findByText(/connected to GitLab project/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Project added: Beta project')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    await waitFor(() => expect(fake.completed).toHaveBeenCalledTimes(1))
    expect(policies.get('alpha')).toMatchObject({ enabled: true, rules: 'Kept draft' })
  })
})
