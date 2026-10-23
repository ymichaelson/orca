import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { mergeRequestHookBody } from '../forge-inbox/forge-inbox-gitlab-fake-server'
import { RuntimeForgeInboxController } from '../runtime/runtime-forge-inbox-controller'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'
import { startOrcadForgeInbox } from './orcad-forge-inbox'

const { analysis } = vi.hoisted(() => ({ analysis: { build: vi.fn() } }))
// Why: the real factory founds a protected Claude session; this file only proves the shell wires it.
vi.mock('../forge-inbox/forge-inbox-analysis-runtime', () => ({
  forgeInboxAnalysisForRuntime: analysis.build
}))

function runtimeStub(settings: ReturnType<ProtectedClaudeAuthDeps['getSettings']> = {}) {
  const controller = new RuntimeForgeInboxController()
  const sessionHost = vi.fn(async () => undefined)
  return {
    controller,
    sessionHost,
    runtime: {
      attachForgeInboxService: (service: Parameters<typeof controller.attach>[0]) =>
        controller.attach(service),
      stopForgeInboxService: () => controller.stopForgeInboxService(),
      dispatchMobileNotification: () => undefined,
      requireStore: () => ({ getSettings: () => settings }),
      resolveRuntimeFileTarget: async (selector: string) => ({
        worktree: { path: `/work/${selector}` },
        executionHostId: 'local' as const
      }),
      ensureStructuredAgentSessionHost: sessionHost
    }
  }
}

describe('orcad forge inbox startup', () => {
  let fx: OwnerFixture
  afterEach(() => {
    vi.restoreAllMocks()
    analysis.build.mockReset()
    analysis.build.mockReturnValue(undefined)
    return fx.dispose()
  })
  beforeEach(() => {
    analysis.build.mockReset()
    analysis.build.mockReturnValue(undefined)
  })

  it('registers its stop before the start settles, and the stop closes the ledger', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const { controller, runtime } = runtimeStub()
    const cleanups: (() => void | Promise<void>)[] = []

    const starting = startOrcadForgeInbox({
      runtime,
      profileDirectory: fx.root,
      http: fx.gate.http,
      registerCleanup: (cleanup) => cleanups.push(cleanup)
    })
    expect(cleanups).toHaveLength(1)
    await starting

    expect(existsSync(join(fx.root, 'forge-inbox.db'))).toBe(true)
    expect(controller.service().status().running).toBe(true)
    await cleanups[0]!()
    expect(controller.service().status().running).toBe(false)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
  })

  it('a shutdown during the start still closes the ledger and the listener', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await provision(seed, listenerOn(port))
    await seed.stop()
    const { controller, runtime } = runtimeStub()
    const cleanups: (() => void | Promise<void>)[] = []

    const starting = startOrcadForgeInbox({
      runtime,
      profileDirectory: fx.root,
      http: fx.gate.http,
      registerCleanup: (cleanup) => cleanups.push(cleanup)
    })
    const cleanedUp = cleanups[0]!()
    await Promise.all([starting, cleanedUp])

    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
    expect(controller.service().status().running).toBe(false)
  })

  it('builds the analysis factory from this host runtime and runs a queued analysis', async () => {
    const settings = { agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'test-key' } } }
    const { controller, runtime, sessionHost } = runtimeStub(settings)
    const kinds: string[] = []
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

    await startOrcadForgeInbox({
      runtime,
      profileDirectory: fx.root,
      http: fx.gate.http,
      registerCleanup: () => undefined
    })
    const input = analysis.build.mock.calls[0]![0]
    expect(input.runtime.requireStore().getSettings()).toBe(settings)
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

  it('logs a failed start, leaves the host starting, and the registered stop still resolves', async () => {
    fx = createOwnerFixture()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedLedger(fx)
    damageLedger(fx)
    const { controller, runtime } = runtimeStub()
    const cleanups: (() => void | Promise<void>)[] = []

    await expect(
      startOrcadForgeInbox({
        runtime,
        profileDirectory: fx.root,
        http: fx.gate.http,
        registerCleanup: (cleanup) => cleanups.push(cleanup)
      })
    ).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledOnce()
    expect(controller.service().status().running).toBe(false)
    await expect(cleanups[0]!()).resolves.toBeUndefined()
  })

  // Booting orcad here would need its whole runtime; the ordering is pinned by the entry point's text.
  it('is registered before the RPC server so reverse cleanup stops RPC first, and feeds idle exit', () => {
    fx = createOwnerFixture()
    const entry = readFileSync(join(import.meta.dirname, 'orcad-entry.ts'), 'utf8')
    expect(entry.indexOf('startOrcadForgeInbox(')).toBeGreaterThan(-1)
    expect(entry.indexOf('startOrcadForgeInbox(')).toBeLessThan(
      entry.indexOf('new OrcaRuntimeRpcServer(')
    )
    expect(entry).toMatch(
      /await startOrcadForgeInbox\(\{[^}]*runtime,[^}]*profileDirectory,[^}]*registerCleanup[^}]*\}\)/
    )
    expect(entry).toContain('forgeInboxBusy: () => runtime.forgeInboxKeepsHostBusy()')
  })
})
