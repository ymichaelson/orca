import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionRuntimeDeps } from '../runtime/structured-agent-session-runtime'
import type * as StructuredAgentSessionRegistry from '../native-chat/agent-session-wire/structured-agent-session-registry'

const installed = vi.hoisted(() =>
  vi.fn<(deps: StructuredAgentSessionRuntimeDeps) => Promise<void>>(async () => {})
)
vi.mock('../runtime/structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: installed
}))
vi.mock(
  '../native-chat/agent-session-wire/structured-agent-session-registry',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StructuredAgentSessionRegistry>()
    return { ...actual, getStructuredAgentSessionHost: () => ({}) }
  }
)
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { INSTANCE_ID, PROJECT_ID } from './forge-inbox-webhook-test-harness'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import { emptyProbe, launchPorts } from './forge-inbox-project-event-agent-launch-test-kit'
import { rowNumber } from './forge-inbox-rows'

const DISPATCH: ProjectEventDecisionResult = {
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action: 'dispatch_agent',
  confidence: 0.9,
  probabilities: {
    record_only: 0.02,
    notify: 0.02,
    wait: 0.02,
    fetch_context: 0.02,
    dispatch_agent: 0.9,
    ask_user: 0.02
  },
  usage: { inputTokens: 12, outputTokens: 3 }
}

describe('project event owner retirement boundary', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('lets the owner close fence the launch a dispatch built, ending its still-running run', async () => {
    fx = createOwnerFixture()
    const probe = emptyProbe()
    const settings = {
      experimentalNativeChat: true,
      agentCmdOverrides: { claude: `"${process.execPath}"` },
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake host only reads store settings.
    const runtime = new OrcaRuntimeService({ getSettings: () => settings } as never)
    const ports = launchPorts(probe, {
      runtime: {
        requireStore: () => ({
          getSettings: () => settings,
          getRepo: () => ({ path: '/work/repo', connectionId: null })
        }),
        // A host that never answers: the launch is still waiting for one when the owner closes.
        getStructuredAgentSessionCreateSupport: () =>
          new Promise<{ supported: boolean }>(() => undefined),
        ensureStructuredAgentSessionHost: () => runtime.ensureStructuredAgentSessionHost()
      }
    })
    const service = fx.service({
      decideProjectEvent: async () => DISPATCH,
      launchProjectEventAgent: (ledger) => createForgeProjectEventAgentLaunch(ledger, ports),
      observeProjectEventContext: (ledger) => async () => {
        const ctx = ledger.ledgerContext()
        const head = ctx.db
          .prepare('SELECT id, current_revision FROM items ORDER BY id LIMIT 1')
          .get()
        if (!head) {
          throw new Error('expected the event item')
        }
        const itemId = rowNumber(head, 'id')
        const revision = rowNumber(head, 'current_revision') + 1
        ctx.db
          .prepare(
            `INSERT INTO item_revisions (item_id, revision, version_token, source_order, created_at)
           VALUES (?, ?, 'sha256:observed', ?, ?)`
          )
          .run(itemId, revision, revision, ctx.now())
        ctx.db
          .prepare('UPDATE items SET current_revision = ?, updated_at = ? WHERE id = ?')
          .run(revision, ctx.now(), itemId)
        return {
          ok: true,
          itemId,
          revision,
          versionToken: 'sha256:observed',
          complete: true,
          newRevision: true,
          kind: 'merge_request',
          iid: 7,
          sha: 'a'.repeat(40),
          title: 'Add thing',
          state: 'opened'
        }
      }
    })
    const port = await freePort()
    await service.start()
    await fx.provision(service, listenerOn(port))
    // The policy in force at the first dispatch decides whether the dispatch may launch.
    const policy = await service.updateProjectPolicy(service.getConfig().configRevision, {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      patch: { agentId: 'claude', model: 'test-model', rules: 'Review the event.' }
    })
    expect(policy).toMatchObject({ ok: true })
    expect((await postHook(port, mergeRequestHookBody(), 'binding-event')).status).toBe(202)
    // The dispatch recorded a run before it could reach a host, and the owner's close stops that launch.
    await vi.waitFor(() => expect(fx.rows('SELECT state, reason FROM runs')).toHaveLength(1))
    await service.stop()
    expect(fx.rows('SELECT state, error FROM runs')).toEqual([
      { state: 'cancelled', error: 'owner-stopped' }
    ])
    // The launch never reached the host, so nothing was created and the host was never installed.
    expect(probe.created).toEqual([])
    expect(installed).not.toHaveBeenCalled()
  })
})
