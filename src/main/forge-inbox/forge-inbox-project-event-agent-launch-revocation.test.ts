import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import {
  emptyProbe,
  launchPorts,
  PROMPT,
  REPO_ID,
  REPO_PATH,
  WORKSPACE_ID,
  type Probe
} from './forge-inbox-project-event-agent-launch-test-kit'
import {
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { transitionForgeRun } from './forge-inbox-runs'

function gate() {
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, release }
}

const REVOCATIONS = [
  ['rules', { rules: 'Review every change twice.' }],
  ['Agent', { agentId: 'codex' }],
  ['model', { model: 'claude-opus-5-5' }],
  ['disabling the policy', { enabled: false }]
] as const

describe('a launch that is revoked while it is pending', () => {
  let fx: DispatchLedgerFixture
  let runId: number
  let itemId: number
  let probe: Probe

  beforeEach(() => {
    fx = openDispatchLedger()
    runId = seedRun(fx.ledger, { iid: 7, sessionId: null, messageId: null })
    itemId = Number(
      fx.ledger.ledgerContext().db.prepare('SELECT item_id FROM runs WHERE id = ?').get(runId)
        ?.item_id
    )
    probe = emptyProbe()
  })
  afterEach(() => fx.dispose())

  function launchWith(ports: ReturnType<typeof launchPorts>) {
    const launch = createForgeProjectEventAgentLaunch(fx.ledger, ports)
    return { launch, run: () => launch({ itemId, repoId: REPO_ID, runId, prompt: PROMPT }) }
  }

  function gatedWorkspace() {
    const held = gate()
    const ports = launchPorts(probe, {
      runtime: {
        resolveRuntimeFileTarget: async (selector) => {
          probe.resolved.push(selector)
          await held.opened
          return {
            worktree: { path: REPO_PATH, id: WORKSPACE_ID, repoId: REPO_ID },
            executionHostId: LOCAL_EXECUTION_HOST_ID
          }
        }
      }
    })
    return { held, ports }
  }

  it.each(REVOCATIONS)(
    'sends nothing when %s changes during workspace resolution',
    async (_n, patch) => {
      const { held, ports } = gatedWorkspace()
      const pending = launchWith(ports).run()
      await flushMicrotasks()

      updatePolicy(fx.ledger, REPO_ID, patch)
      held.release()

      expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
      expect(probe.created).toEqual([])
      expect(probe.delivered).toEqual([])
      expect(probe.terminal).toEqual([])
      expect(runRow(fx.ledger, runId)).toMatchObject({ session_id: null, state: 'running' })
    }
  )

  it.each([
    ['a budget', { budgets: { timeoutSeconds: 900 } }],
    ['an event toggle', { events: { reviewRequests: true } }]
  ])(
    'sends nothing when %s changes before it sent anything, as a queued run would be revoked',
    async (_name, patch) => {
      const { held, ports } = gatedWorkspace()
      const pending = launchWith(ports).run()
      await flushMicrotasks()

      updatePolicy(fx.ledger, REPO_ID, patch)
      held.release()

      expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
      expect(probe.created).toEqual([])
      expect(probe.delivered).toEqual([])
    }
  )

  it('is not revoked by a no-op or stale save', async () => {
    const { held, ports } = gatedWorkspace()
    const pending = launchWith(ports).run()
    await flushMicrotasks()
    const current = fx.ledger.getProjectEventPolicy(REPO_ID)
    if (!current) {
      throw new Error('fixture policy missing')
    }

    fx.ledger.updateProjectEventPolicy(REPO_ID, current.generation, { rules: current.rules })
    fx.ledger.updateProjectEventPolicy(REPO_ID, current.generation - 1, { rules: 'Stale.' })
    held.release()

    expect(await pending).toMatchObject({ ok: true, mode: 'structured' })
    expect(probe.delivered).toHaveLength(1)
  })

  it('creates no session when the policy is revoked while the host starts', async () => {
    const held = gate()
    const ports = launchPorts(probe, {
      runtime: { ensureStructuredAgentSessionHost: () => held.opened }
    })
    ports.createStructuredSession = async (args) => {
      await args.ensureHost()
      probe.created.push(args)
      return { ok: true, value: { sessionId: args.envelope.sessionId, fence: 4 } }
    }
    const pending = launchWith(ports).run()
    await flushMicrotasks()

    updatePolicy(fx.ledger, REPO_ID, { rules: 'New rules.' })
    held.release()

    expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
    expect(probe.created).toEqual([])
    expect(probe.delivered).toEqual([])
    expect(runRow(fx.ledger, runId).session_id).toBeNull()
  })

  it.each(REVOCATIONS)(
    'keeps the created session and sends no prompt when %s changes during the create',
    async (_n, patch) => {
      const held = gate()
      const ports = launchPorts(probe)
      const create = ports.createStructuredSession
      ports.createStructuredSession = async (args) => {
        await held.opened
        return create(args)
      }
      const pending = launchWith(ports).run()
      await flushMicrotasks()

      updatePolicy(fx.ledger, REPO_ID, patch)
      held.release()

      expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
      expect(probe.delivered).toEqual([])
      expect(probe.terminal).toEqual([])
      const [created] = probe.created
      expect(runRow(fx.ledger, runId)).toMatchObject({
        session_id: created?.envelope.sessionId,
        dispatch_client_message_id: null,
        cancel_requested_at: expect.any(Number)
      })
    }
  )

  it('does not fall back to a terminal when revoked while a refused create settles', async () => {
    const held = gate()
    const ports = launchPorts(probe, {
      refusal: { code: 'structured_agent_session_unsupported', message: 'no chat' }
    })
    const create = ports.createStructuredSession
    ports.createStructuredSession = async (args) => {
      await held.opened
      return create(args)
    }
    const pending = launchWith(ports).run()
    await flushMicrotasks()

    updatePolicy(fx.ledger, REPO_ID, { enabled: false })
    held.release()

    expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
    expect(probe.terminal).toEqual([])
    expect(probe.delivered).toEqual([])
  })

  it('starts no terminal when revoked while the launch mode is decided', async () => {
    const held = gate()
    const ports = launchPorts(probe, {
      runtime: {
        getStructuredAgentSessionCreateSupport: async () => {
          await held.opened
          return { supported: false, reason: 'agent' }
        }
      }
    })
    const pending = launchWith(ports).run()
    await flushMicrotasks()

    updatePolicy(fx.ledger, REPO_ID, { agentId: 'codex' })
    held.release()

    expect(await pending).toEqual({ ok: false, code: 'policy-revoked' })
    expect(probe.terminal).toEqual([])
    expect(probe.created).toEqual([])
  })

  it('does not undo a prompt already handed over; the stop it needs is already requested', async () => {
    const held = gate()
    const ports = launchPorts(probe)
    const deliver = ports.deliverStructuredPrompt
    ports.deliverStructuredPrompt = async (args) => {
      await held.opened
      return deliver(args)
    }
    const pending = launchWith(ports).run()
    await flushMicrotasks()

    updatePolicy(fx.ledger, REPO_ID, { rules: 'New rules.' })
    held.release()

    expect(await pending).toMatchObject({ ok: true, mode: 'structured' })
    expect(probe.delivered).toHaveLength(1)
    expect(runRow(fx.ledger, runId)).toMatchObject({
      state: 'running',
      cancel_requested_at: expect.any(Number),
      dispatch_client_message_id: probe.delivered[0]?.clientMessageId
    })
  })

  it('refuses every effect once the launcher is stopped', async () => {
    const { held, ports } = gatedWorkspace()
    const { launch, run } = launchWith(ports)
    const pending = run()
    await flushMicrotasks()

    const stopped = launch.stop?.()
    held.release()

    expect(await pending).toEqual({ ok: false, code: 'owner-stopped' })
    await stopped
    expect(probe.created).toEqual([])
    expect(probe.delivered).toEqual([])
    expect(await run()).toEqual({ ok: false, code: 'owner-stopped' })
    expect(probe.resolved).toHaveLength(1)
  })

  it('sends nothing for a run that is no longer running', async () => {
    const { held, ports } = gatedWorkspace()
    const pending = launchWith(ports).run()
    await flushMicrotasks()

    transitionForgeRun(fx.ledger.ledgerContext(), runId, { to: 'cancelled', error: 'cancelled' })
    held.release()

    expect(await pending).toMatchObject({ ok: false })
    expect(probe.created).toEqual([])
    expect(probe.delivered).toEqual([])
    expect(runRow(fx.ledger, runId).state).toBe('cancelled')
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve()
  }
}
