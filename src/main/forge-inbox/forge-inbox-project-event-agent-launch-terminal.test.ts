import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import {
  emptyProbe,
  launchPorts,
  PROMPT,
  REPO_ID,
  WORKSPACE_ID,
  type Probe
} from './forge-inbox-project-event-agent-launch-test-kit'
import {
  openDispatchLedger,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import {
  createFakeTerminalRuntime,
  PTY_A,
  terminalRow
} from './forge-inbox-project-event-terminal-test-kit'

const TERMINAL_MODE = {
  requireStore: () => ({
    getSettings: () => ({ experimentalNativeChat: false }),
    getRepo: () => ({ path: '/work/repo', connectionId: null })
  })
}

describe('a dispatch records what it was launched as', () => {
  let fx: DispatchLedgerFixture
  let runId: number
  let itemId: number
  let probe: Probe
  let fake: ReturnType<typeof createFakeTerminalRuntime>

  beforeEach(() => {
    fx = openDispatchLedger()
    runId = seedRun(fx.ledger, { iid: 7, sessionId: null, messageId: null })
    itemId = Number(
      fx.ledger.ledgerContext().db.prepare('SELECT item_id FROM runs WHERE id = ?').get(runId)
        ?.item_id
    )
    probe = emptyProbe()
    fake = createFakeTerminalRuntime()
    fake.terminals.set('terminal-1', { ...PTY_A, executionHostId: LOCAL_EXECUTION_HOST_ID })
  })
  afterEach(() => fx.dispose())

  function launcher(options: Parameters<typeof launchPorts>[1] = {}, extra = {}) {
    const launch = createForgeProjectEventAgentLaunch(fx.ledger, {
      ...launchPorts(probe, options),
      terminals: fake.runtime,
      ...extra
    })
    return {
      launch,
      run: () => launch({ itemId, repoId: REPO_ID, runId, prompt: PROMPT }),
      stop: () => launch.stop?.()
    }
  }

  it('keeps the exact terminal it started and starts observing its process', async () => {
    const { run, stop } = launcher({ runtime: TERMINAL_MODE })

    expect(await run()).toMatchObject({ ok: true, mode: 'terminal' })

    const row = fx.ledger
      .ledgerContext()
      .db.prepare(
        `SELECT state, error, terminal_handle, terminal_pty_id, terminal_incarnation_id,
           terminal_execution_host_id, terminal_worktree_id FROM runs WHERE id = ?`
      )
      .get(runId)
    expect(row).toEqual({
      state: 'unverifiable',
      error: 'terminal-handoff',
      terminal_handle: 'terminal-1',
      terminal_pty_id: 'pty-a',
      terminal_incarnation_id: 'incarnation-a',
      terminal_execution_host_id: LOCAL_EXECUTION_HOST_ID,
      terminal_worktree_id: WORKSPACE_ID
    })
    await expect.poll(() => fake.waiterCount()).toBe(1)
    expect(fake.waits).toEqual(['terminal-1'])
    await stop()
  })

  it('records an incomplete identity as absent and observes nothing', async () => {
    const { run, stop } = launcher({
      runtime: {
        ...TERMINAL_MODE,
        launchAgentTerminal: async (selector, launch) => {
          probe.terminal.push({ selector, ...launch })
          return { handle: 'terminal-1' }
        }
      }
    })

    await run()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(terminalRow(fx.ledger, runId)).toMatchObject({ terminal_handle: 'terminal-1' })
    expect(fake.waits).toEqual([])
    await stop()
  })

  it('snapshots the selected Agent and requested model before the structured send', async () => {
    const { run } = launcher()

    expect(await run()).toMatchObject({ ok: true, mode: 'structured' })

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      dispatch_agent_id: 'claude',
      dispatch_requested_model: 'claude-sonnet-5-5',
      dispatch_actual_model: null
    })
  })

  it('keeps the Agent default as no requested model and never guesses an actual one', async () => {
    updatePolicy(fx.ledger, REPO_ID, { model: null })
    const modelFree = seedRun(fx.ledger, { iid: 8, sessionId: null, messageId: null })
    const { launch } = launcher({ runtime: TERMINAL_MODE })

    await launch({ itemId, repoId: REPO_ID, runId: modelFree, prompt: PROMPT })
    runId = modelFree

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      dispatch_agent_id: 'claude',
      dispatch_requested_model: null,
      dispatch_actual_model: null
    })
  })

  it('records the model the runtime itself reports for the created session', async () => {
    const { run } = launcher({}, { reportedModel: () => 'claude-opus-5-5' })

    await run()

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      dispatch_requested_model: 'claude-sonnet-5-5',
      dispatch_actual_model: 'claude-opus-5-5'
    })
  })

  it('leaves the actual model unknown when the runtime has none to report', async () => {
    const { run } = launcher({}, { reportedModel: () => undefined })

    await run()

    expect(terminalRow(fx.ledger, runId).dispatch_actual_model).toBeNull()
  })

  it('does not follow a later policy change', async () => {
    const { run } = launcher()
    await run()

    updatePolicy(fx.ledger, REPO_ID, { agentId: 'codex', model: 'other-model' })
    await run().catch(() => undefined)

    expect(terminalRow(fx.ledger, runId)).toMatchObject({
      dispatch_agent_id: 'claude',
      dispatch_requested_model: 'claude-sonnet-5-5'
    })
  })

  it('records nothing for a launch revoked before it dispatched anything', async () => {
    updatePolicy(fx.ledger, REPO_ID, { enabled: false })
    const { run } = launcher()

    expect(await run()).toMatchObject({ ok: false })

    expect(terminalRow(fx.ledger, runId).dispatch_agent_id).toBeNull()
  })
})
