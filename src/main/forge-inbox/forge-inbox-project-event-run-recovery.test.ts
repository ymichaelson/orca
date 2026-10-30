import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import type { ForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import { createDispatchConfirmation } from './forge-inbox-dispatch-confirmation'
import { recoverInterruptedProjectEventRuns } from './forge-inbox-project-event-run-recovery'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  readForgeRun,
  transitionForgeRun
} from './forge-inbox-runs'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }

type ProofReader = {
  read: (sessionId: string, clientMessageId: string) => Promise<ForgeProtectedTurnProof | null>
  asked: string[]
}

function proofsByMessage(
  entries: Record<string, ForgeProtectedTurnProof | null>,
  throwFor: readonly string[] = []
): ProofReader {
  const asked: string[] = []
  return {
    asked,
    read: async (_sessionId, clientMessageId) => {
      asked.push(clientMessageId)
      if (throwFor.includes(clientMessageId)) {
        throw new Error('journal unavailable')
      }
      return entries[clientMessageId] ?? null
    }
  }
}

function terminal(outcome: AgentJournalTurnOutcome): ForgeProtectedTurnProof {
  return { turnId: 'turn-1', terminal: true, outcome, text: null }
}

const UNFINISHED: ForgeProtectedTurnProof = {
  turnId: 'turn-1',
  terminal: false,
  outcome: null,
  text: null
}

describe('project event run recovery', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let nextIid = 7

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
  })
  afterEach(() => {
    harness.dispose()
  })

  function runningRun(clientMessageId: string | null, sessionId = 'structured-claude-1'): number {
    const observed = ledger.ingestObservation(
      {
        hostId: ledger.hostId,
        ...SCOPE,
        projectId: 'group/project',
        kind: 'merge_request',
        iid: nextIid++,
        dedupeKey: `d-${Math.random()}`,
        eventKind: 'merge_request.review_requested',
        payload: {},
        versionToken: 'sha256:v1',
        queueRun: { reason: 'project-event-dispatch' }
      },
      ledger.getConfig().configRevision,
      0
    )
    if (!observed.ok || observed.duplicate || observed.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(observed)}`)
    }
    const ctx = ledger.ledgerContext()
    if (!transitionForgeRun(ctx, observed.runId, { to: 'running' }).ok) {
      throw new Error('run did not start')
    }
    if (!bindForgeRunSession(ctx, observed.runId, sessionId)) {
      throw new Error('session did not bind')
    }
    if (
      clientMessageId !== null &&
      !bindForgeRunDispatchTurn(ctx, observed.runId, clientMessageId)
    ) {
      throw new Error('dispatch turn did not bind')
    }
    return observed.runId
  }

  function restart(): void {
    ledger.close()
    ledger = harness.open()
  }

  function run(runId: number) {
    return readForgeRun(ledger.ledgerContext(), runId)
  }

  it('replaces the interruption verdict with the turn success', async () => {
    const runId = runningRun('msg-success')
    restart()
    expect(run(runId)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })

    const result = await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-success': terminal('success') }).read
    })

    expect(result).toEqual({ recovered: 1, unproven: 0 })
    expect(run(runId)).toMatchObject({ state: 'succeeded', error: null })
  })

  function confirmationOf(runId: number) {
    return ledger
      .ledgerContext()
      .db.prepare(
        'SELECT state, session_id, client_message_id, turn_id, report_json FROM run_dispatch_confirmations WHERE run_id = ?'
      )
      .get(runId)
  }

  function confirm(runId: number): void {
    createDispatchConfirmation(ledger.ledgerContext(), {
      runId,
      bindingId: 'binding-1',
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 3,
      itemKind: 'merge_request',
      itemIid: 7,
      expectedSha: null
    })
  }

  it('keeps the recovered turn report and identity, leaving the dispatch unconfirmed', async () => {
    const runId = runningRun('msg-report')
    confirm(runId)
    restart()
    const report = { v: 1, mode: 'read-only', claims: [] }
    const proofs = proofsByMessage({
      'msg-report': {
        ...terminal('success'),
        text: `Looked only.\n\`\`\`orca-effect-report\n${JSON.stringify(report)}\n\`\`\``
      }
    })

    await recoverInterruptedProjectEventRuns({ ledger, readTurnProof: proofs.read })

    expect(run(runId)).toMatchObject({ state: 'succeeded' })
    expect(confirmationOf(runId)).toEqual({
      state: 'unconfirmed',
      session_id: 'structured-claude-1',
      client_message_id: 'msg-report',
      turn_id: 'turn-1',
      report_json: JSON.stringify({ status: 'claims', mode: 'read-only', claims: [] })
    })
  })

  it('records a missing report when the recovered turn has no provable text', async () => {
    const runId = runningRun('msg-silent')
    confirm(runId)
    restart()
    const proofs = proofsByMessage({ 'msg-silent': terminal('failure') })

    await recoverInterruptedProjectEventRuns({ ledger, readTurnProof: proofs.read })

    expect(run(runId)).toMatchObject({ state: 'failed' })
    expect(confirmationOf(runId)).toMatchObject({
      state: 'unconfirmed',
      report_json: JSON.stringify({ status: 'report-missing' })
    })
  })

  it('records the recovered turn text as the result, matching the live watch, and keeps it after reopen', async () => {
    const runId = runningRun('msg-text')
    confirm(runId)
    restart()
    const report = '```orca-effect-report\n{"v":1,"mode":"read-only","claims":[]}\n```'
    const proofs = proofsByMessage({
      'msg-text': { ...terminal('success'), text: `Looked only.\n\n${report}` }
    })

    await recoverInterruptedProjectEventRuns({ ledger, readTurnProof: proofs.read })
    restart()

    expect(run(runId)).toMatchObject({
      state: 'succeeded',
      result: { summary: 'Looked only.', concerns: [] }
    })
  })

  it('leaves the result unavailable for a recovered turn without text', async () => {
    const runId = runningRun('msg-mute')
    restart()

    await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-mute': terminal('failure') }).read
    })

    expect(run(runId)).toMatchObject({ state: 'failed', result: null })
  })

  it('captures nothing for a turn it could not prove', async () => {
    const runId = runningRun('msg-unknown')
    confirm(runId)
    restart()

    await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-unknown': UNFINISHED }).read
    })

    expect(confirmationOf(runId)).toMatchObject({ report_json: null, turn_id: null })
  })

  it('maps a failed turn to a failed run', async () => {
    const runId = runningRun('msg-failure')
    restart()

    await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-failure': terminal('failure') }).read
    })

    expect(run(runId)).toMatchObject({ state: 'failed', error: 'agent-failure' })
  })

  it('maps a cancelled turn to a cancelled run', async () => {
    const runId = runningRun('msg-cancelled')
    restart()

    await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-cancelled': terminal('cancellation') }).read
    })

    expect(run(runId)).toMatchObject({ state: 'cancelled', error: 'cancelled' })
  })

  it('leaves a run untouched when its turn cannot be proven', async () => {
    const absent = runningRun('msg-absent')
    const unfinished = runningRun('msg-unfinished', 'structured-claude-2')
    const unresolved = runningRun('msg-unresolved', 'structured-claude-3')
    restart()
    const generations = [absent, unfinished, unresolved].map((runId) => run(runId)?.generation)

    const result = await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({
        'msg-unfinished': UNFINISHED,
        'msg-unresolved': { turnId: 'turn-1', terminal: true, outcome: null, text: null }
      }).read
    })

    expect(result).toEqual({ recovered: 0, unproven: 3 })
    for (const [index, runId] of [absent, unfinished, unresolved].entries()) {
      expect(run(runId)).toMatchObject({
        state: 'unverifiable',
        error: 'unknown-outcome',
        generation: generations[index]
      })
    }
  })

  it('never asks about a run that recorded no dispatch turn', async () => {
    const untracked = runningRun(null)
    const tracked = runningRun('msg-tracked', 'structured-claude-2')
    restart()
    const reader = proofsByMessage({ 'msg-tracked': terminal('success') })

    const result = await recoverInterruptedProjectEventRuns({ ledger, readTurnProof: reader.read })

    expect(result).toEqual({ recovered: 1, unproven: 0 })
    expect(reader.asked).toEqual(['msg-tracked'])
    expect(run(untracked)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })
    expect(run(tracked)).toMatchObject({ state: 'succeeded' })
  })

  it('keeps recovering after one journal read throws', async () => {
    const broken = runningRun('msg-broken')
    const healthy = runningRun('msg-healthy', 'structured-claude-2')
    restart()

    const result = await recoverInterruptedProjectEventRuns({
      ledger,
      readTurnProof: proofsByMessage({ 'msg-healthy': terminal('success') }, ['msg-broken']).read
    })

    expect(result).toEqual({ recovered: 1, unproven: 1 })
    expect(run(broken)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })
    expect(run(healthy)).toMatchObject({ state: 'succeeded' })
  })

  it('recovers nothing the second time it runs', async () => {
    const runId = runningRun('msg-once')
    restart()
    const deps = {
      ledger,
      readTurnProof: proofsByMessage({ 'msg-once': terminal('success') }).read
    }

    expect(await recoverInterruptedProjectEventRuns(deps)).toEqual({ recovered: 1, unproven: 0 })
    expect(await recoverInterruptedProjectEventRuns(deps)).toEqual({ recovered: 0, unproven: 0 })
    expect(run(runId)).toMatchObject({ state: 'succeeded' })
  })

  it('bounds the whole pass when the journal never answers', async () => {
    runningRun('msg-a')
    runningRun('msg-b')
    runningRun('msg-c')
    restart()
    const started = Date.now()

    const result = await recoverInterruptedProjectEventRuns({
      ledger,
      totalTimeoutMs: 40,
      readTimeoutMs: 25,
      readTurnProof: () => new Promise(() => {})
    })

    expect(result).toEqual({ recovered: 0, unproven: 3 })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('writes nothing once the caller no longer owns the ledger', async () => {
    const runId = runningRun('msg-late')
    restart()
    let current = true

    const result = await recoverInterruptedProjectEventRuns({
      ledger,
      isCurrent: () => current,
      readTurnProof: async () => {
        current = false
        return terminal('success')
      }
    })

    expect(result.recovered).toBe(0)
    expect(run(runId)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })
  })
})
