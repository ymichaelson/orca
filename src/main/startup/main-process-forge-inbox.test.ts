import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRequestHookBody } from '../forge-inbox/forge-inbox-gitlab-fake-server'
import { ForgeInboxLedger } from '../forge-inbox/forge-inbox-ledger'
import { ingestForgeEventInTransaction } from '../forge-inbox/forge-inbox-ingest'
import { INSTANCE_ID } from '../forge-inbox/forge-inbox-webhook-test-harness'
import {
  connectRefused,
  createOwnerFixture,
  damageLedger,
  seedLedger,
  freePort,
  listenerOn,
  type OwnerFixture
} from '../forge-inbox/forge-inbox-owner-service-test-kit'
import type { ForgeInboxOwnerService } from '../forge-inbox/forge-inbox-owner-service'
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
import {
  CANCEL_MESSAGE,
  createFakeCancelHost,
  seedCommittedStop
} from '../forge-inbox/forge-inbox-project-event-run-cancel-test-kit'
import { RuntimeForgeInboxController } from '../runtime/runtime-forge-inbox-controller'
import type { ProtectedClaudeAuthDeps } from '../claude/claude-protected-auth'

type RuntimeSettings = ReturnType<ProtectedClaudeAuthDeps['getSettings']> & {
  projectEventReceiver?: ReturnType<OwnerFixture['receiverSettings']['read']>
}

type AttachingRuntime = {
  attachForgeInboxService: (service: ForgeInboxOwnerService) => void
  dispatchMobileNotification: () => void
  requireStore: () => { getSettings: () => RuntimeSettings; getRepo: () => undefined }
  resolveRuntimeFileTarget: (selector: string) => Promise<{
    worktree: { path: string }
    executionHostId: 'local'
  }>
  ensureStructuredAgentSessionHost: () => Promise<void>
}

function analysisRuntime(settings: RuntimeSettings = {}): AttachingRuntime {
  return {
    attachForgeInboxService: () => undefined,
    dispatchMobileNotification: () => undefined,
    requireStore: () => ({ getSettings: () => settings, getRepo: () => undefined }),
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

const { state, network } = vi.hoisted(() => ({
  state: {
    activeOrcaProfile: { profileDirectory: '' },
    initialProxyApplicationReady: Promise.resolve(),
    runtime: initialRuntime()
  },
  network: {
    http: {
      fetch: async (_url: string, _init?: RequestInit): Promise<Response> => new Response('{}')
    }
  }
}))

vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('../network/http-client', () => ({ getMainHttpClient: () => network.http }))

import { initializeMainProcessForgeInbox } from './main-process-forge-inbox'

function seedLegacyRun(fx: OwnerFixture): void {
  const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
  try {
    const ctx = ledger.ledgerContext()
    const item = ingestForgeEventInTransaction(ctx, {
      hostId: ctx.hostId,
      instanceId: INSTANCE_ID,
      projectId: '42',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'legacy-event',
      eventKind: 'Merge Request Hook',
      versionToken: 'legacy-head',
      sourceOrder: 1,
      payload: {}
    })
    if (item.duplicate) {
      throw new Error('expected a new historical item')
    }
    // This queued run predates retirement and is not newly admitted work.
    ctx.db
      .prepare(
        `INSERT INTO runs (item_id, revision, state, generation, policy_generation, context_digest,
        analysis_kind, reason, created_at, updated_at)
       SELECT i.id, i.current_revision, 'queued', 0, COALESCE(p.generation, 0), r.version_token,
        i.kind, 'review-request', ?, ? FROM items i
       JOIN item_revisions r ON r.item_id = i.id AND r.revision = i.current_revision
       LEFT JOIN policies p ON p.instance_id = i.instance_id AND p.project_id = i.project_id
       WHERE i.id = ?`
      )
      .run(Date.now(), Date.now(), item.itemId)
  } finally {
    ledger.close()
  }
}

function seedLegacyDelivery(fx: OwnerFixture): void {
  const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
  try {
    const ctx = ledger.ledgerContext()
    // This is a retained row from an earlier host, not a live admission path.
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
        config_revision, admitted_at, state, body) VALUES (?, ?, '42', 'm-1', 'Merge Request Hook', ?, ?, 'pending', ?)`
      )
      .run(
        ctx.hostId,
        INSTANCE_ID,
        ledger.getConfig().configRevision,
        Date.now(),
        Buffer.from(JSON.stringify(mergeRequestHookBody({ reviewers: ['me'] })))
      )
  } finally {
    ledger.close()
  }
}

describe('desktop forge inbox startup', () => {
  let fx: OwnerFixture
  let userData: string
  let controller: RuntimeForgeInboxController
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'forge-desktop-userdata-'))
    controller = new RuntimeForgeInboxController()
    state.runtime = {
      ...analysisRuntime({
        get projectEventReceiver() {
          return fx?.receiverSettings.read()
        }
      }),
      attachForgeInboxService: (service) => controller.attach(service)
    }
    state.initialProxyApplicationReady = Promise.resolve()
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

  it('retains an ordinary queued legacy run without executing it on restart', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    const seed = fx.service()
    await seed.start()
    await fx.provision(seed, listenerOn(port), {
      project: { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }
    })
    await seed.stop()
    seedLegacyRun(fx)

    await initializeMainProcessForgeInbox()
    await controller.service().settled()

    expect(fx.rows('SELECT state, session_id FROM runs')).toEqual([
      { state: 'queued', session_id: null }
    ])
  })

  it('delivers a stop committed before the restart through its own launcher, launching nothing', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const { runId, operationId } = seedCommittedStop(fx.dbPath, fx.store, {
      sessionId: HOST_TEST_SESSION
    })
    const journal = createFakeCancelHost()
    journal.startTurn({ messageId: CANCEL_MESSAGE, turnId: 'turn-1' })
    const real = await openRealCancelHost(journal)
    const uninstall = installRegistryHost(real.host)
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    try {
      await initializeMainProcessForgeInbox()
      await vi.waitFor(() => expect(real.cancels).toHaveBeenCalledTimes(1))
    } finally {
      uninstall()
    }

    expect(real.cancels.mock.calls[0]?.[0]).toEqual({ callerKey: `forge-dispatch:${runId}` })
    expect(real.cancels.mock.calls[0]?.[1]).toMatchObject({
      turnId: 'turn-1',
      envelope: { clientOperationId: operationId, sessionId: HOST_TEST_SESSION }
    })
    expect(fx.rows('SELECT id, state FROM runs')).toEqual([{ id: runId, state: 'unverifiable' }])
  })

  it('closes the exact terminal a committed stop names and records its exit as a process fact', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    const runId = seedCommittedTerminalStop(fx.dbPath, fx.store)
    const terminals = createFakeTerminalRuntime()
    terminals.terminals.set('handle-1', PTY_A)
    state.runtime = {
      ...analysisRuntime(),
      ...terminals.runtime,
      attachForgeInboxService: (service) => controller.attach(service)
    }
    state.activeOrcaProfile = { profileDirectory: fx.root }
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    await vi.waitFor(() => expect(terminals.closes).toEqual(['handle-1']))
    terminals.exit('handle-1', 0, { kind: 'operator_close' })

    await vi.waitFor(() =>
      expect(fx.rows('SELECT terminal_exit_kind AS kind FROM runs WHERE id = ?', runId)).toEqual([
        { kind: 'operator_close' }
      ])
    )
    expect(fx.rows('SELECT state FROM runs WHERE id = ?', runId)).toEqual([
      { state: 'unverifiable' }
    ])
    expect(fx.rows('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 1 }])
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

  it('keeps a recovered legacy delivery as history without advertising pending work', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await fx.provision(seed, listenerOn(port))
    await seed.stop()
    seedLegacyDelivery(fx)
    state.activeOrcaProfile = { profileDirectory: fx.root }
    state.initialProxyApplicationReady = Promise.resolve()
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    await controller.service().settled()

    expect(fx.deliveries()).toMatchObject([{ state: 'pending' }])
    expect(controller.service().status().work.pending).toBe(0)
    expect(controller.service().idle()).toBe(true)
  })

  it('binds the recovered listener while retained legacy deliveries remain untouched', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await fx.provision(seed, listenerOn(port))
    await seed.stop()
    seedLegacyDelivery(fx)
    const requestsBefore = fx.gitlab.requests.length
    const proxy = Promise.withResolvers<void>()
    state.activeOrcaProfile = { profileDirectory: fx.root }
    state.initialProxyApplicationReady = proxy.promise
    network.http = fx.gate.http

    await initializeMainProcessForgeInbox()
    expect(controller.service().status().listener.listening).toBe(true)
    expect(fx.gitlab.requests).toHaveLength(requestsBefore)

    proxy.resolve()
    await controller.service().settled()
    expect(fx.deliveries()).toMatchObject([{ state: 'pending' }])
    expect(fx.gitlab.requests).toHaveLength(requestsBefore)
  })

  it('a quit during the start leaves no open ledger and no bound listener', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seed = fx.service()
    await seed.start()
    await fx.provision(seed, listenerOn(port))
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
