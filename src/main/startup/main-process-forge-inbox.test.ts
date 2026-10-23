import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from '../forge-inbox/forge-inbox-gitlab-fake-server'
import {
  connectRefused,
  createOwnerFixture,
  damageLedger,
  seedLedger,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import type { ForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
import { RuntimeForgeInboxController } from '../runtime/runtime-forge-inbox-controller'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'

type RuntimeSettings = ReturnType<ProtectedClaudeAuthDeps['getSettings']>

type AttachingRuntime = {
  attachForgeInboxService: (service: ForgeInboxOwnerService) => void
  requireStore: () => { getSettings: () => RuntimeSettings }
  resolveRuntimeFileTarget: (selector: string) => Promise<{
    worktree: { path: string }
    executionHostId: 'local'
  }>
  ensureStructuredAgentSessionHost: () => Promise<void>
}

function analysisRuntime(settings: RuntimeSettings = {}): AttachingRuntime {
  return {
    attachForgeInboxService: () => undefined,
    requireStore: () => ({ getSettings: () => settings }),
    resolveRuntimeFileTarget: async (selector) => ({
      worktree: { path: `/work/${selector}` },
      executionHostId: 'local'
    }),
    ensureStructuredAgentSessionHost: async () => undefined
  }
}

function initialRuntime(): AttachingRuntime | null {
  return null
}

const { state, network, analysis } = vi.hoisted(() => ({
  state: {
    activeOrcaProfile: { profileDirectory: '' },
    initialProxyApplicationReady: Promise.resolve(),
    runtime: initialRuntime()
  },
  network: {
    http: {
      fetch: async (_url: string, _init?: RequestInit): Promise<Response> => new Response('{}')
    }
  },
  analysis: { build: vi.fn() }
}))

vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('../network/http-client', () => ({ getMainHttpClient: () => network.http }))
// Why: the real factory founds a protected Claude session; this file only proves the shell wires it.
vi.mock('../forge-inbox/forge-inbox-analysis-runtime', () => ({
  forgeInboxAnalysisForRuntime: analysis.build
}))

import { initializeMainProcessForgeInbox } from './main-process-forge-inbox'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('desktop forge inbox startup', () => {
  let fx: OwnerFixture
  let userData: string
  let controller: RuntimeForgeInboxController
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'forge-desktop-userdata-'))
    controller = new RuntimeForgeInboxController()
    state.runtime = {
      ...analysisRuntime(),
      attachForgeInboxService: (service) => controller.attach(service)
    }
    state.initialProxyApplicationReady = Promise.resolve()
    analysis.build.mockReset()
    analysis.build.mockReturnValue(undefined)
  })
  afterEach(async () => {
    await controller.stopForgeInboxService()
    await fx?.dispose()
    rmSync(userData, { recursive: true, force: true })
  })

  it('attaches once, with the ledger in the active profile directory and not the user data root', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()

    expect(controller.service().status().running).toBe(true)
    expect(controller.service().getConfig().hostId).toBeTruthy()
    expect(existsSync(join(userData, 'forge-inbox.db'))).toBe(false)
  })

  it('builds the analysis factory from the attached runtime and runs a queued analysis', async () => {
    const settings = { agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'test-key' } } }
    const binding = analysisRuntime(settings)
    const sessionHost = vi.fn(async () => undefined)
    const kinds: string[] = []
    state.runtime = {
      ...binding,
      ensureStructuredAgentSessionHost: sessionHost,
      attachForgeInboxService: (service) => controller.attach(service)
    }
    analysis.build.mockImplementation(
      () =>
        (ledger: { getConfig(): { configRevision: number } }) =>
        async ({
          run,
          bindSession
        }: {
          run: { analysisKind: string }
          bindSession: (id: string) => void
        }) => {
          expect(ledger.getConfig().configRevision).toBeGreaterThan(0)
          kinds.push(run.analysisKind)
          bindSession('session-1')
          return { kind: 'analysed', result: { summary: 'Looks fine', concerns: [] } }
        }
    )
    fx = createOwnerFixture()
    const port = await freePort()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    const input = analysis.build.mock.calls[0]![0]
    expect(input.runtime.requireStore().getSettings()).toBe(settings)
    expect(await input.runtime.resolveRuntimeFileTarget('id:ws-1')).toMatchObject({
      worktree: { path: '/work/id:ws-1' }
    })
    await input.runtime.ensureStructuredAgentSessionHost()
    expect(sessionHost).toHaveBeenCalledOnce()

    await provision(controller.service(), listenerOn(port), {
      project: { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }
    })
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await controller.service().settled()

    expect(kinds).toEqual(['merge_request'])
    expect(fx.rows('SELECT state FROM runs')).toEqual([{ state: 'succeeded' }])
  })

  it('leaves a profile that never used the feature without a ledger and quits at once', async () => {
    fx = createOwnerFixture()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    await controller.stopForgeInboxService()

    expect(controller.service().status().running).toBe(false)
    expect(controller.keepsHostBusy()).toBe(false)
    expect(existsSync(join(fx.root, 'forge-inbox.db'))).toBe(false)
  })

  it('holds the first drain for the proxy settings but binds the recovered listener at once', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service({ now: () => Date.now() - 120_000 })
    await seed.start()
    await provision(seed, listenerOn(port))
    fx.gate.hold()
    fx.gate.delayAbortCompletion()
    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await fx.gate.requestBlocked()
    const stopping = seed.stop()
    await fx.gate.abortObserved()
    fx.gate.releaseAbortedRequests()
    await stopping
    fx.gate.release()
    const requestsBefore = fx.gitlab.requests.length
    const proxy = Promise.withResolvers<void>()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    state.initialProxyApplicationReady = proxy.promise
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    for (let i = 0; i < 10; i++) {
      await tick()
    }
    expect(controller.service().status().listener.listening).toBe(true)
    expect(fx.gitlab.requests).toHaveLength(requestsBefore)

    proxy.resolve()
    await controller.service().settled()
    // No credential in the default store, so a drain that ran parks the row instead of fetching.
    expect(fx.deliveries()).toMatchObject([{ state: 'needs-auth' }])
  })

  it('a quit during the start leaves no open ledger and no bound listener', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await provision(seed, listenerOn(port))
    await seed.stop()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    const starting = initializeMainProcessForgeInbox()
    const stopping = controller.stopForgeInboxService()
    await Promise.all([starting, stopping])

    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
  })

  it('lets the host finish starting when the ledger cannot open, with the service left unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    fx = createOwnerFixture()
    await seedLedger(fx)
    damageLedger(fx)
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    await expect(initializeMainProcessForgeInbox()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledOnce()
    expect(controller.service().status().running).toBe(false)
    expect(existsSync(join(userData, 'forge-inbox.db'))).toBe(false)
    error.mockRestore()
  })
})
