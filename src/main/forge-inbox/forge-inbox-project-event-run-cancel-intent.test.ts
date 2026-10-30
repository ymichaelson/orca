import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordRunTerminalExit } from './forge-inbox-project-event-run-terminal-state'
import { seedTerminalRun } from './forge-inbox-project-event-terminal-test-kit'
import {
  CANCEL_REPO_ID,
  OPERATION_ID_PATTERN,
  OTHER_REPO_ID,
  openDispatchLedger,
  runRow,
  seedRun,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'

describe('a policy change commits the stop of the dispatches it revokes', () => {
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

  it.each([
    ['rules', { rules: 'Review every change twice.' }],
    ['Agent', { agentId: 'codex' }],
    ['model', { model: 'claude-opus-5-5' }],
    ['disabling the policy', { enabled: false }]
  ])('requests a stop of the running dispatch when %s changes', (_name, patch) => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const before = runRow(fx.ledger, runId)

    const generation = updatePolicy(fx.ledger, CANCEL_REPO_ID, patch)

    const after = runRow(fx.ledger, runId)
    expect(after.cancel_requested_at).toEqual(expect.any(Number))
    expect(after.cancel_operation_id).toMatch(OPERATION_ID_PATTERN)
    expect(after.cancel_policy_generation).toBe(generation)
    expect(after.cancel_delivery).toBeNull()
    // Asking is not stopping: the run stays running and keeps the policy it was dispatched under.
    expect(after).toMatchObject({
      state: 'running',
      generation: before.generation,
      policy_generation: before.policy_generation,
      session_id: before.session_id,
      dispatch_client_message_id: before.dispatch_client_message_id
    })
  })

  it('also asks an interrupted run that may still be running to stop', () => {
    const runId = seedRun(fx.ledger, { iid: 7, state: 'unverifiable' })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    expect(runRow(fx.ledger, runId)).toMatchObject({
      state: 'unverifiable',
      cancel_requested_at: expect.any(Number)
    })
  })

  it('also asks a terminal dispatch whose process has not been seen to exit to stop', () => {
    const open = seedTerminalRun(fx.ledger, { iid: 7 })
    const exited = seedTerminalRun(fx.ledger, { iid: 8 })
    recordRunTerminalExit(
      fx.ledger.ledgerContext(),
      { runId: exited, itemId: itemOf(exited) },
      { kind: 'exited', value: 0 }
    )

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { agentId: 'codex' })

    expect(runRow(fx.ledger, open)).toMatchObject({
      state: 'unverifiable',
      cancel_requested_at: expect.any(Number)
    })
    expect(runRow(fx.ledger, exited).cancel_requested_at).toBeNull()
  })

  it('leaves everything else untouched', () => {
    const otherRepo = seedRun(fx.ledger, { iid: 8, gitlabPath: 'group/other' })
    const analysis = seedRun(fx.ledger, { iid: 9, reason: 'review_request' })
    const legacy = seedRun(fx.ledger, { iid: 10, instanceId: 'config-1' })
    const settled = seedRun(fx.ledger, { iid: 11, state: 'succeeded' })
    const queued = seedRun(fx.ledger, { iid: 12, state: 'queued' })

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New rules.' })

    for (const runId of [otherRepo, analysis, legacy, settled]) {
      expect(runRow(fx.ledger, runId).cancel_requested_at).toBeNull()
    }
    expect(runRow(fx.ledger, otherRepo).state).toBe('running')
    // A queued dispatch never started, so it is revoked outright rather than asked to stop.
    expect(runRow(fx.ledger, queued)).toMatchObject({
      state: 'superseded',
      cancel_requested_at: null
    })
  })

  it('requests nothing for a no-op or stale save, or a change that leaves the dispatch valid', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const current = fx.ledger.getProjectEventPolicy(CANCEL_REPO_ID)
    if (!current) {
      throw new Error('fixture policy missing')
    }

    expect(
      fx.ledger.updateProjectEventPolicy(CANCEL_REPO_ID, current.generation, {
        rules: current.rules
      })
    ).toMatchObject({ ok: true, generation: current.generation })
    expect(
      fx.ledger.updateProjectEventPolicy(CANCEL_REPO_ID, current.generation - 1, {
        rules: 'Stale.'
      })
    ).toMatchObject({ ok: false, reason: 'stale-generation' })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { budgets: { timeoutSeconds: 900 } })
    updatePolicy(fx.ledger, CANCEL_REPO_ID, { events: { reviewRequests: true } })

    expect(runRow(fx.ledger, runId)).toMatchObject({ state: 'running', cancel_requested_at: null })
  })

  it('keeps the first request when a second change arrives', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const first = updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'One.' })
    const asked = runRow(fx.ledger, runId)

    updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'Two.' })

    expect(runRow(fx.ledger, runId)).toMatchObject({
      cancel_requested_at: asked.cancel_requested_at,
      cancel_operation_id: asked.cancel_operation_id,
      cancel_policy_generation: first
    })
  })

  it('commits the request and the policy together or not at all', () => {
    const runId = seedRun(fx.ledger, { iid: 7 })
    const generation = fx.ledger.getProjectEventPolicy(CANCEL_REPO_ID)?.generation
    fx.ledger.ledgerContext().db.exec(
      `CREATE TRIGGER refuse_cancel_change BEFORE INSERT ON changes
         WHEN NEW.change = 'cancel-requested' BEGIN SELECT RAISE(ABORT, 'refused'); END`
    )

    expect(() => updatePolicy(fx.ledger, CANCEL_REPO_ID, { rules: 'New.' })).toThrow(/refused/)

    expect(fx.ledger.getProjectEventPolicy(CANCEL_REPO_ID)?.generation).toBe(generation)
    expect(runRow(fx.ledger, runId).cancel_requested_at).toBeNull()
  })

  it('announces the request on the change feed of its own item only', () => {
    seedRun(fx.ledger, { iid: 7 })
    seedRun(fx.ledger, { iid: 8, gitlabPath: 'group/other' })

    updatePolicy(fx.ledger, OTHER_REPO_ID, { rules: 'Other rules.' })

    const changes = fx.ledger
      .ledgerContext()
      .db.prepare("SELECT item_id FROM changes WHERE change = 'cancel-requested'")
      .all()
    expect(changes).toHaveLength(1)
  })
})
