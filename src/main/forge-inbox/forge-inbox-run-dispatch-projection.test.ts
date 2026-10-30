import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectForgeItemDetail } from './forge-inbox-read-projection'
import {
  openDispatchLedger,
  seedRun,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import {
  bindDispatchSnapshot,
  recordDispatchActualModel,
  recordRunTerminalExit
} from './forge-inbox-project-event-run-terminal-state'
import { seedTerminalRun } from './forge-inbox-project-event-terminal-test-kit'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

describe('the run view carries the dispatch snapshot and the terminal exit, allowlisted', () => {
  let fx: DispatchLedgerFixture
  beforeEach(() => {
    fx = openDispatchLedger()
  })
  afterEach(() => fx.dispose())

  function itemOf(runId: number): number {
    return Number(
      fx.ledger.ledgerContext().db.prepare('SELECT item_id FROM runs WHERE id = ?').get(runId)
        ?.item_id
    )
  }

  function runView(runId: number) {
    const detail = fx.ledger.getItemDetail(SCOPE, itemOf(runId), 'client-1')
    if (!detail) {
      throw new Error('expected the item detail')
    }
    const view = projectForgeItemDetail(detail)
    return { run: view.runs[0], serialized: JSON.stringify(view) }
  }

  it('shows the Agent and requested model, and the Agent default as no model', () => {
    const named = seedRun(fx.ledger, { iid: 7 })
    bindDispatchSnapshot(fx.ledger.ledgerContext(), named, {
      agentId: 'claude',
      requestedModel: 'claude-sonnet-5-5'
    })
    const standard = seedRun(fx.ledger, { iid: 8 })
    bindDispatchSnapshot(fx.ledger.ledgerContext(), standard, {
      agentId: 'codex',
      requestedModel: null
    })

    expect(runView(named).run?.dispatchSnapshot).toEqual({
      agentId: 'claude',
      requestedModel: 'claude-sonnet-5-5',
      actualModel: null
    })
    expect(runView(standard).run?.dispatchSnapshot).toEqual({
      agentId: 'codex',
      requestedModel: null,
      actualModel: null
    })
  })

  it('reports an actual model only when one was recorded, and never rewrites the snapshot', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const ctx = fx.ledger.ledgerContext()
    bindDispatchSnapshot(ctx, runId, { agentId: 'claude', requestedModel: null })
    recordDispatchActualModel(ctx, runId, 'claude-opus-5-5')
    bindDispatchSnapshot(ctx, runId, { agentId: 'codex', requestedModel: 'changed' })
    recordDispatchActualModel(ctx, runId, 'another')

    expect(runView(runId).run?.dispatchSnapshot).toEqual({
      agentId: 'claude',
      requestedModel: null,
      actualModel: 'claude-opus-5-5'
    })
  })

  it('shows a terminal exit as a process fact with the time it was seen', () => {
    const runId = seedTerminalRun(fx.ledger)
    recordRunTerminalExit(
      fx.ledger.ledgerContext(),
      { runId, itemId: itemOf(runId) },
      { kind: 'exited', value: 0 }
    )

    const { run, serialized } = runView(runId)

    expect(run?.terminalExit).toEqual({ kind: 'exited', value: 0, observedAt: expect.any(Number) })
    // Exit zero is not a task result: the run is not succeeded and the effect row is not confirmed.
    expect(run).toMatchObject({ state: 'unverifiable', errorCode: 'terminal-handoff' })
    expect(run?.dispatchConfirmation?.state).toBe('unconfirmable')
    expect(serialized).not.toContain('terminal_pty_id')
    expect(serialized).not.toContain('pty-a')
    expect(serialized).not.toContain('incarnation-a')
  })

  it('omits anything outside its vocabulary', () => {
    const runId = seedTerminalRun(fx.ledger)
    fx.ledger
      .ledgerContext()
      .db.prepare(
        `UPDATE runs SET dispatch_agent_id = 'not-an-agent', terminal_exit_kind = 'mystery',
           terminal_exit_at = 5 WHERE id = ?`
      )
      .run(runId)

    const { run } = runView(runId)

    expect(run).not.toHaveProperty('dispatchSnapshot')
    expect(run).not.toHaveProperty('terminalExit')
  })

  it('bounds a model name and leaves an older run without either fact', () => {
    const long = seedRun(fx.ledger, { iid: 7 })
    bindDispatchSnapshot(fx.ledger.ledgerContext(), long, {
      agentId: 'claude',
      requestedModel: 'm'.repeat(500)
    })
    const old = seedRun(fx.ledger, { iid: 8 })

    expect(runView(long).run?.dispatchSnapshot?.requestedModel).toHaveLength(200)
    expect(runView(old).run).not.toHaveProperty('dispatchSnapshot')
  })
})
