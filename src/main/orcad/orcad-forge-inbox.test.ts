import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectRefused,
  createOwnerFixture,
  damageLedger,
  seedLedger,
  freePort,
  listenerOn,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import { createForgeProjectEventAgentLaunch } from '../forge-inbox/forge-inbox-project-event-agent-launch'
import {
  emptyProbe,
  launchPorts
} from '../forge-inbox/forge-inbox-project-event-agent-launch-test-kit'
import {
  createFakeTerminalRuntime,
  PTY_A,
  seedCommittedTerminalStop
} from '../forge-inbox/forge-inbox-project-event-terminal-test-kit'
import {
  HOST_TEST_SESSION,
  installRegistryHost,
  openRealCancelHost
} from '../forge-inbox/forge-inbox-project-event-run-cancel-host-kit'
import { projectEventRunCancelRuntimeFor } from '../forge-inbox/forge-inbox-project-event-run-cancel-runtime'
import {
  CANCEL_MESSAGE,
  createFakeCancelHost,
  seedCommittedStop
} from '../forge-inbox/forge-inbox-project-event-run-cancel-test-kit'
import { RuntimeForgeInboxController } from '../runtime/runtime-forge-inbox-controller'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'
import { startOrcadForgeInbox } from './orcad-forge-inbox'

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
      requireStore: () => ({ getSettings: () => settings, getRepo: () => undefined }),
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
    return fx.dispose()
  })

  it('registers its stop before the start settles, and the stop closes the ledger', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const { controller, runtime } = runtimeStub()
    const cleanups: (() => void | Promise<void>)[] = []

    const starting = startOrcadForgeInbox({
      runtime,
      profileDirectory: fx.root,
      receiverSettings: fx.receiverSettings,
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

  it('delivers a stop committed before the restart through the launcher it is given', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const { runId, operationId } = seedCommittedStop(fx.dbPath, fx.store, {
      sessionId: HOST_TEST_SESSION
    })
    const journal = createFakeCancelHost()
    journal.startTurn({ messageId: CANCEL_MESSAGE, turnId: 'turn-1' })
    const real = await openRealCancelHost(journal)
    const uninstall = installRegistryHost(real.host)
    const { controller, runtime } = runtimeStub()
    const probe = emptyProbe()

    try {
      await startOrcadForgeInbox({
        runtime,
        profileDirectory: fx.root,
        receiverSettings: fx.receiverSettings,
        http: fx.gate.http,
        launchProjectEventAgent: (ledger) =>
          createForgeProjectEventAgentLaunch(ledger, {
            ...launchPorts(probe),
            cancel: projectEventRunCancelRuntimeFor(runtime)
          }),
        registerCleanup: () => undefined
      })
      await vi.waitFor(() => expect(real.cancels).toHaveBeenCalledTimes(1))
    } finally {
      uninstall()
      await controller.stopForgeInboxService()
    }

    expect(real.cancels.mock.calls[0]?.[0]).toEqual({ callerKey: `forge-dispatch:${runId}` })
    expect(real.cancels.mock.calls[0]?.[1]).toMatchObject({
      turnId: 'turn-1',
      envelope: { clientOperationId: operationId }
    })
    expect(probe).toEqual(emptyProbe())
    expect(fx.rows('SELECT id, state FROM runs')).toEqual([{ id: runId, state: 'unverifiable' }])
  })

  it('closes the exact terminal a committed stop names through the launcher it is given', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const runId = seedCommittedTerminalStop(fx.dbPath, fx.store)
    const terminals = createFakeTerminalRuntime()
    terminals.terminals.set('handle-1', PTY_A)
    const { controller, runtime } = runtimeStub()
    const probe = emptyProbe()

    try {
      await startOrcadForgeInbox({
        runtime,
        profileDirectory: fx.root,
        receiverSettings: fx.receiverSettings,
        http: fx.gate.http,
        launchProjectEventAgent: (ledger) =>
          createForgeProjectEventAgentLaunch(ledger, {
            ...launchPorts(probe),
            terminals: terminals.runtime
          }),
        registerCleanup: () => undefined
      })
      await vi.waitFor(() => expect(terminals.closes).toEqual(['handle-1']))
    } finally {
      await controller.stopForgeInboxService()
    }

    expect(probe).toEqual(emptyProbe())
    expect(fx.rows('SELECT state FROM runs WHERE id = ?', runId)).toEqual([
      { state: 'unverifiable' }
    ])
  })

  it('a shutdown during the start still closes the ledger and the listener', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await fx.provision(seed, listenerOn(port))
    await seed.stop()
    const { controller, runtime } = runtimeStub()
    const cleanups: (() => void | Promise<void>)[] = []

    const starting = startOrcadForgeInbox({
      runtime,
      profileDirectory: fx.root,
      receiverSettings: fx.receiverSettings,
      http: fx.gate.http,
      registerCleanup: (cleanup) => cleanups.push(cleanup)
    })
    const cleanedUp = cleanups[0]!()
    await Promise.all([starting, cleanedUp])

    expect(await connectRefused(port)).toBe(true)
    expect(existsSync(join(fx.root, 'forge-inbox.db-wal'))).toBe(false)
    expect(controller.service().status().running).toBe(false)
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
        receiverSettings: fx.receiverSettings,
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
    expect(entry).toContain(
      'launchProjectEventAgent: forgeInboxProjectEventAgentLaunchForRuntime(runtime)'
    )
  })
})
