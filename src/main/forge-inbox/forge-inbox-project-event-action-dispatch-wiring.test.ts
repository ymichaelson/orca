import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  claimProjectEventAction,
  getProjectEventActionSchedule,
  linkProjectEventDecisionItem,
  PROJECT_EVENT_WIRED_ACTIONS
} from './forge-inbox-project-event-action'
import {
  createDispatchConfirmation,
  readDispatchConfirmation
} from './forge-inbox-dispatch-confirmation'
import { reconcileDispatchConfirmations } from './forge-inbox-dispatch-confirmation-reconcile'
import type { DispatchConfirmationReader } from './forge-inbox-dispatch-confirmation-reader'
import { readForgeItemHandling } from './forge-inbox-item-handling'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-action-dispatch'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { answerProjectEventQuestion } from './forge-inbox-project-event-question-answer'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { createForgeProjectEventAgentLaunch } from './forge-inbox-project-event-agent-launch'
import { queueForgeItemRun } from './forge-inbox-ingest'
import { createForgeProjectEventRunWatch } from './forge-inbox-project-event-run-watch'
import { recoverInterruptedForgeWork } from './forge-inbox-interrupted-work'
import { rowNumber } from './forge-inbox-rows'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import {
  bindForgeRunDispatchTurn,
  bindForgeRunSession,
  transitionForgeRun
} from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'
import {
  decisionFor,
  openDispatchWiringFixture,
  REPO_ID,
  WORKSPACE_ID,
  type DispatchWiringFixture
} from './forge-inbox-project-event-dispatch-wiring-fixture'

type WiringProbe = Parameters<DispatchWiringFixture['launchPorts']>[0]

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one entry, got ${items.length}`)
  }
  return first
}

describe('project event dispatch wiring', () => {
  let fixture: DispatchWiringFixture
  let ledger: ForgeInboxLedger
  let bindingId: string
  let ctx: DispatchWiringFixture['ctx']
  let record: DispatchWiringFixture['record']
  let observe: DispatchWiringFixture['observe']
  let wiringProbe: DispatchWiringFixture['wiringProbe']
  let launchPorts: DispatchWiringFixture['launchPorts']
  let decisionRow: DispatchWiringFixture['decisionRow']
  let deliveryRow: DispatchWiringFixture['deliveryRow']
  let runs: DispatchWiringFixture['runs']

  beforeEach(() => {
    fixture = openDispatchWiringFixture()
    ledger = fixture.ledger
    bindingId = fixture.bindingId
    ctx = fixture.ctx
    record = fixture.record
    observe = fixture.observe
    wiringProbe = fixture.wiringProbe
    launchPorts = fixture.launchPorts
    decisionRow = fixture.decisionRow
    deliveryRow = fixture.deliveryRow
    runs = fixture.runs
  })

  afterEach(() => fixture.close())

  it('claims a queued dispatch action under the default wired actions', () => {
    record('dispatch_agent')

    expect(PROJECT_EVENT_WIRED_ACTIONS).toContain('dispatch_agent')
    expect(getProjectEventActionSchedule(ctx())).toMatchObject({ pending: 1 })
    expect(claimProjectEventAction(ctx())?.action).toBe('dispatch_agent')
  })

  it('drains a dispatch through the wired action into a running session', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()

    expect(
      await drainProjectEventActions(ctx(), {
        limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
        observeContext: observe(),
        launchAgentFactory: () => createForgeProjectEventAgentLaunch(ledger, launchPorts(probe)),
        launchAgentLedger: ledger
      })
    ).toEqual({ executed: 1, failed: 0, capped: false })

    const sessionId = only(probe.created).envelope.sessionId
    expect(decisionRow()).toMatchObject({ action_state: 'done', run_id: 1, last_error_code: null })
    expect(deliveryRow(1)).toMatchObject({ state: 'done' })
    expect(runs()).toEqual([
      expect.objectContaining({
        state: 'running',
        reason: 'project-event-dispatch',
        session_id: sessionId,
        error: null
      })
    ])
    expect(only(probe.delivered)).toMatchObject({
      callerKey: 'forge-dispatch:1',
      text: expect.stringContaining('Add thing')
    })
  })

  async function drainWatched(
    probe: WiringProbe,
    options: { text?: string | null; sha?: string } = {}
  ) {
    let complete: (event: AgentSessionTurnCompletionEvent) => void = () => {}
    const ports = launchPorts(probe)
    const runWatch = createForgeProjectEventRunWatch({
      ledger,
      readTurnProof: async () => ({
        turnId: 'turn-1',
        terminal: true,
        outcome: 'success',
        text: options.text ?? null
      }),
      subscribeTurnCompletions: (subscriber) => {
        complete = subscriber.emit
        return () => {}
      }
    })
    ports.runWatch = runWatch
    await drainProjectEventActions(ctx(), {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      observeContext: observe(options.sha),
      launchAgentFactory: () => createForgeProjectEventAgentLaunch(ledger, ports),
      launchAgentLedger: ledger
    })
    return {
      dispose: () => runWatch.dispose(),
      succeedTurn: async () => {
        complete({
          type: 'completion',
          completion: {
            scope: {
              executionHostId: LOCAL_EXECUTION_HOST_ID,
              wslDistro: null,
              workspaceId: WORKSPACE_ID,
              workspaceKind: 'git-worktree'
            },
            sessionId: only(probe.created).envelope.sessionId,
            turnId: 'turn-1',
            outcome: 'success',
            completedAt: 1
          }
        })
        for (let turn = 0; turn < 10; turn++) {
          await Promise.resolve()
        }
      }
    }
  }

  async function watchSeededPreparation(
    text: string,
    change: 'revoke' | 'head' | 'cancel' | null = null
  ) {
    const deliveryId = record('ask_user')
    const action = claimProjectEventAction(ctx(), ['ask_user'])
    if (!action || !linkProjectEventDecisionItem(ctx(), action).ok) {
      throw new Error('expected a linked ask_user decision')
    }
    await observe()()
    const runId = queueForgeItemRun(ctx(), 1, PROJECT_EVENT_DISPATCH_RUN_REASON)
    if (runId === null || !transitionForgeRun(ctx(), runId, { to: 'running' }).ok) {
      throw new Error('expected a running preparation')
    }
    createDispatchConfirmation(ctx(), {
      runId,
      bindingId,
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 3,
      itemIid: 7,
      itemKind: 'merge_request',
      expectedSha: null
    })
    const bound =
      bindForgeRunSession(ctx(), runId, 'session-1') &&
      bindForgeRunDispatchTurn(ctx(), runId, 'message-1')
    if (!bound) {
      throw new Error('expected the preparation turn identity')
    }
    ctx()
      .db.prepare(`UPDATE project_event_decisions SET run_id = ?, action_state = 'blocked',
      action_token = NULL WHERE id = ?`)
      .run(runId, action.decisionId)
    ctx()
      .db.prepare(`UPDATE webhook_deliveries SET state = 'parked', parked_reason = 'preparing-question'
      WHERE id = ?`)
      .run(deliveryId)
    if (change === 'head') {
      await observe()()
      ctx()
        .db.prepare(`UPDATE item_revisions SET version_token = 'sha256:new-head'
        WHERE item_id = 1 AND revision = 3`)
        .run()
    }
    if (change === 'cancel') {
      ctx()
        .db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE id = ?')
        .run(ctx().now(), runId)
    }
    if (change === 'revoke') {
      updateProjectEventPolicy(ctx(), {
        repoId: REPO_ID,
        expectedGeneration: 1,
        patch: { enabled: false }
      })
    }
    const proofReads: { sessionId: string; clientMessageId: string }[] = []
    const watch = createForgeProjectEventRunWatch({
      ledger,
      readTurnProof: async (sessionId, clientMessageId) => {
        proofReads.push({ sessionId, clientMessageId })
        return { turnId: 'turn-1', terminal: true, outcome: 'success', text }
      },
      subscribeTurnCompletions: () => () => {}
    })
    watch.watch('session-1', runId, 'message-1', { proveNow: true })
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve()
    }
    expect(proofReads).toEqual([{ sessionId: 'session-1', clientMessageId: 'message-1' }])
    watch.dispose()
  }

  it('does not reconcile a failed preparation as a business effect', async () => {
    record('ask_user')
    const watched = await drainWatched(wiringProbe())
    expect(transitionForgeRun(ctx(), 1, { to: 'failed', error: 'dispatch-unverifiable' }).ok).toBe(
      true
    )
    let reads = 0
    await reconcileDispatchConfirmations(ctx(), {
      createReader: () => {
        reads += 1
        return gitlabReader({})
      }
    })
    expect(reads).toBe(0)
    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('unconfirmed')
    watched.dispose()
  })

  it('prepares a grounded question, answers it and dispatches distinct work on the same head', async () => {
    const deliveryId = record('ask_user')
    const probe = wiringProbe()
    const question = 'Should we release A or B?'
    const text = `\`\`\`orca-question\n{"v":1,"kind":"question","question":${JSON.stringify(question)}}\n\`\`\``
    const watched = await drainWatched(probe, { text })
    expect(probe.delivered).toHaveLength(1)
    expect(ctx().db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
    await watched.succeedTurn()
    const row = ctx().db.prepare('SELECT id FROM project_event_questions').get()
    const questionId = row ? rowNumber(row, 'id') : -1
    expect(
      ctx().db.prepare('SELECT question, subject_kind FROM project_event_questions').all()
    ).toEqual([{ question, subject_kind: 'merge_request' }])
    const answer = answerProjectEventQuestion(ctx(), {
      ownerHostId: ctx().hostId,
      questionId,
      answer: 'Release B'
    })
    expect(answer.ok).toBe(true)
    const next = claimProjectEventDecision(ctx())
    expect(JSON.stringify(next?.input.context)).toContain(question)
    expect(JSON.stringify(next?.input.context)).toContain('Release B')
    const action = next && decisionFor('dispatch_agent')
    expect(next && action && decideProjectEventDelivery(ctx(), deliveryId, action, next).ok).toBe(
      true
    )
    const business = wiringProbe()
    const drain = { limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, observeContext: observe() }
    await drainProjectEventActions(ctx(), {
      ...drain,
      launchAgentFactory: () => createForgeProjectEventAgentLaunch(ledger, launchPorts(business)),
      launchAgentLedger: ledger
    })
    expect(business.delivered).toHaveLength(1)
    expect(only(business.delivered).text).toContain(question)
    expect(only(business.delivered).text).toContain('Release B')
    expect(
      ctx().db.prepare('SELECT id, context_digest, origin_question_id FROM runs ORDER BY id').all()
    ).toEqual([
      { id: 1, context_digest: 'sha256:observed', origin_question_id: null },
      { id: 2, context_digest: 'sha256:observed', origin_question_id: questionId }
    ])
    watched.dispose()
  })

  it('publishes only the exact question from the preparation turn proof', async () => {
    const question = 'Release A or B? <b>plain text</b>'
    const text = `\`\`\`orca-question\n{"v":1,"kind":"question","question":${JSON.stringify(question)}}\n\`\`\``
    await watchSeededPreparation(text)

    expect(
      ctx().db.prepare('SELECT question, subject_kind FROM project_event_questions').all()
    ).toEqual([{ question, subject_kind: 'merge_request' }])
  })

  it('never publishes a question from a revoked preparation proof', async () => {
    await watchSeededPreparation(
      '```orca-question\n{"v":1,"kind":"question","question":"Release A or B?"}\n```',
      'revoke'
    )
    expect(ctx().db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
  })

  it.each(['head', 'cancel'] as const)('never publishes proof after %s', async (change) => {
    await watchSeededPreparation(
      '```orca-question\n{"v":1,"kind":"question","question":"Release A or B?"}\n```',
      change
    )
    expect(ctx().db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
    expect(ctx().db.prepare('SELECT state FROM webhook_deliveries').get()).toEqual({
      state: 'failed'
    })
  })

  it.each([
    'not JSON',
    '```orca-question\n{"v":1,"kind":"question","question":""}\n```',
    `\`\`\`orca-question\n{"v":1,"kind":"question","question":${JSON.stringify('x'.repeat(4001))}}\n\`\`\``,
    '```orca-question\n{"v":1,"kind":"question","question":"a"}\n```\n```orca-question\n{"v":1,"kind":"question","question":"b"}\n```'
  ])('blocks invalid preparation output without a fallback question', async (text) => {
    await watchSeededPreparation(text)
    expect(ctx().db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
    expect(ctx().db.prepare('SELECT state, last_error_code FROM webhook_deliveries').get()).toEqual(
      { state: 'failed', last_error_code: 'dispatch-unverifiable' }
    )
  })

  it('keeps a declined preparation open for its task instead of publishing the decline as a question', async () => {
    await watchSeededPreparation('```orca-question\n{"v":1,"kind":"cannot_prepare"}\n```')
    expect(ctx().db.prepare('SELECT question FROM project_event_questions').all()).toEqual([])
    expect(
      ctx().db.prepare('SELECT state, parked_reason, last_error_code FROM webhook_deliveries').get()
    ).toEqual({ state: 'parked', parked_reason: 'preparing-question', last_error_code: null })
    expect(
      ctx()
        .db.prepare('SELECT run_id, action_state, last_error_code FROM project_event_decisions')
        .get()
    ).toEqual({ run_id: 1, action_state: 'queued', last_error_code: 'preparing-question' })
  })

  it('records the remote side effects of a dispatch as unconfirmed when it launches', async () => {
    record('dispatch_agent')

    const watched = await drainWatched(wiringProbe())

    expect(readDispatchConfirmation(ctx(), 1)).toMatchObject({
      runId: 1,
      state: 'unconfirmed',
      bindingId,
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 3,
      itemKind: 'merge_request',
      itemIid: 7,
      expectedSha: null,
      marker: expect.stringMatching(/^<!-- orca-run:1:[0-9a-f]{32} -->$/)
    })
    expect(readForgeItemHandling(ctx(), 1).state).toBe('processing')
    watched.dispose()
  })

  function confirmationRow() {
    const sql = `SELECT c.state, c.session_id, c.client_message_id, c.turn_id, c.report_json,
      r.session_id AS run_session, r.dispatch_client_message_id AS run_message
      FROM run_dispatch_confirmations c JOIN runs r ON r.id = c.run_id WHERE c.run_id = 1`
    const row = ctx().db.prepare(sql).get()
    if (!row) {
      throw new Error('expected the confirmation row')
    }
    return row
  }

  it('stores the head sha the agent was prompted with', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()

    const watched = await drainWatched(probe, { sha: 'b'.repeat(40) })

    expect(readDispatchConfirmation(ctx(), 1)?.expectedSha).toBe('b'.repeat(40))
    expect(only(probe.delivered).text).toContain(`"revision":{"sha":"${'b'.repeat(40)}"}`)
    watched.dispose()
  })

  it('hands the agent the marker the host stored, outside the event data', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()

    const watched = await drainWatched(probe)

    const marker = readDispatchConfirmation(ctx(), 1)?.marker ?? ''
    const text = only(probe.delivered).text
    expect(marker).toMatch(/^<!-- orca-run:1:/)
    expect(text).toContain(marker)
    expect(text.indexOf(marker)).toBeLessThan(text.indexOf('<event-data>'))
    watched.dispose()
  })

  it('keeps the final report and the turn identity when the dispatched turn succeeds', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()
    const report = {
      v: 1,
      mode: 'remote-actions',
      claims: [{ kind: 'comment', target: { kind: 'merge_request', iid: 7 }, noteId: 301 }]
    }
    const text = `Commented.\n\n\`\`\`orca-effect-report\n${JSON.stringify(report)}\n\`\`\``
    const watched = await drainWatched(probe, { text })

    await watched.succeedTurn()

    expect(confirmationRow()).toMatchObject({
      state: 'unconfirmed',
      session_id: only(probe.created).envelope.sessionId,
      turn_id: 'turn-1',
      report_json: JSON.stringify({
        status: 'claims',
        mode: 'remote-actions',
        claims: report.claims
      })
    })
    expect(confirmationRow().client_message_id).toBe(confirmationRow().run_message)
    expect(confirmationRow().run_message).not.toBeNull()
    watched.dispose()
  })

  function reportBlock(claims: unknown[]): string {
    const report = { v: 1, mode: 'remote-actions', claims }
    return `Done.\n\`\`\`orca-effect-report\n${JSON.stringify(report)}\n\`\`\``
  }

  function gitlabReader(options: {
    marker?: string
    approved?: boolean
  }): DispatchConfirmationReader {
    return {
      getCurrentUser: async () => ({
        ok: true,
        complete: true,
        data: { name: 'Ada', username: 'ada', email: null, commit_email: null }
      }),
      listMergeRequestNotes: async () => ({
        ok: true,
        complete: true,
        data:
          options.marker === undefined
            ? []
            : [{ id: 9, system: false, author: 'ada', body: options.marker, updated_at: 'x' }]
      }),
      listIssueNotes: async () => ({ ok: true, complete: true, data: [] }),
      getMergeRequestState: async () => ({
        ok: true,
        complete: true,
        data: { iid: 7, state: 'opened', sha: 'c'.repeat(40), targetProjectId: 3, mergedBy: null }
      }),
      getMergeRequestApprovals: async () => ({
        ok: true,
        complete: true,
        data: {
          approved: options.approved === true,
          approvedBy: [],
          userHasApproved: options.approved === true
        }
      })
    }
  }

  it('shows the item done only once GitLab shows the reported comment', async () => {
    record('dispatch_agent')
    const text = reportBlock([{ kind: 'comment', target: { kind: 'merge_request', iid: 7 } }])
    const watched = await drainWatched(wiringProbe(), { text })
    await watched.succeedTurn()
    expect(readForgeItemHandling(ctx(), 1).state).toBe('unconfirmed')

    const marker = readDispatchConfirmation(ctx(), 1)?.marker ?? ''
    await reconcileDispatchConfirmations(ctx(), { createReader: () => gitlabReader({ marker }) })

    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('confirmed')
    expect(readForgeItemHandling(ctx(), 1)).toEqual({ state: 'done', errorCode: null })
    watched.dispose()
  })

  it('keeps the item unconfirmed when GitLab contradicts the reported approval', async () => {
    record('dispatch_agent')
    const text = reportBlock([{ kind: 'approve', target: { kind: 'merge_request', iid: 7 } }])
    const watched = await drainWatched(wiringProbe(), { sha: 'c'.repeat(40), text })
    await watched.succeedTurn()

    await reconcileDispatchConfirmations(ctx(), { createReader: () => gitlabReader({}) })

    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('contradicted')
    expect(readForgeItemHandling(ctx(), 1).state).toBe('unconfirmed')
    watched.dispose()
  })

  it('records a missing report when the turn text was not provable', async () => {
    record('dispatch_agent')
    const watched = await drainWatched(wiringProbe(), { text: null })

    await watched.succeedTurn()

    expect(confirmationRow()).toMatchObject({
      state: 'unconfirmed',
      report_json: JSON.stringify({ status: 'report-missing' })
    })
    watched.dispose()
  })

  it('keeps an item unconfirmed, not done, once the dispatched turn succeeds', async () => {
    record('dispatch_agent')
    const watched = await drainWatched(wiringProbe())

    await watched.succeedTurn()

    expect(runs()).toEqual([expect.objectContaining({ state: 'succeeded' })])
    expect(readForgeItemHandling(ctx(), 1)).toEqual({ state: 'unconfirmed', errorCode: null })
    watched.dispose()
  })

  it('settles an undeliverable dispatch as blocked and fails its run', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()

    expect(
      await drainProjectEventActions(ctx(), {
        limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
        observeContext: observe(),
        launchAgentFactory: () =>
          createForgeProjectEventAgentLaunch(
            ledger,
            launchPorts(probe, { code: 'agent_session_operation_unknown', message: 'no answer' })
          ),
        launchAgentLedger: ledger
      })
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      run_id: 1,
      last_error_code: 'dispatch-failed'
    })
    expect(deliveryRow(1)).toMatchObject({ state: 'failed', last_error_code: 'dispatch-failed' })
    expect(runs()).toEqual([
      expect.objectContaining({ state: 'failed', error: 'dispatch-failed', session_id: null })
    ])
    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('no-claim')
  })

  it('leaves a dispatch unverifiable when the send outcome is unknown', async () => {
    record('dispatch_agent')
    const probe = wiringProbe()
    const ports = launchPorts(probe)
    ports.deliverStructuredPrompt = async () => {
      throw new Error('socket_closed')
    }

    await drainProjectEventActions(ctx(), {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      observeContext: observe(),
      launchAgentFactory: () => createForgeProjectEventAgentLaunch(ledger, ports),
      launchAgentLedger: ledger
    })

    const sessionId = only(probe.created).envelope.sessionId
    expect(runs()).toEqual([
      expect.objectContaining({
        state: 'unverifiable',
        error: 'unknown-outcome',
        session_id: sessionId
      })
    ])
    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('unconfirmed')
  })

  it('refuses a dispatch when the host wired no launcher', async () => {
    record('dispatch_agent')

    expect(
      await drainProjectEventActions(ctx(), { limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS })
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      run_id: null,
      last_error_code: 'dispatch-unavailable'
    })
    expect(deliveryRow(1)).toMatchObject({
      state: 'failed',
      last_error_code: 'dispatch-unavailable'
    })
    expect(runs()).toEqual([])
  })

  it('fails a dispatch whose prompt cannot be built', async () => {
    record('dispatch_agent')
    ctx()
      .db.prepare('UPDATE project_bindings SET project_path = ? WHERE binding_id = ?')
      .run('p'.repeat(9000), bindingId)
    let launched = false

    expect(
      await drainProjectEventActions(ctx(), {
        limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
        observeContext: observe(),
        launchAgentFactory: () => async () => {
          launched = true
          throw new Error('the launcher must not run')
        },
        launchAgentLedger: ledger
      })
    ).toEqual({ executed: 0, failed: 1, capped: false })

    expect(launched).toBe(false)
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      run_id: 1,
      last_error_code: 'dispatch-failed'
    })
    expect(deliveryRow(1)).toMatchObject({ state: 'failed', last_error_code: 'dispatch-failed' })
    expect(runs()).toEqual([
      expect.objectContaining({ state: 'failed', error: 'dispatch-failed', session_id: null })
    ])
    expect(readDispatchConfirmation(ctx(), 1)?.state).toBe('no-claim')
  })

  it('marks an interrupted dispatch unverifiable instead of interrupted', async () => {
    record('dispatch_agent')
    const claimed = claimProjectEventAction(ctx(), ['dispatch_agent'])
    if (!claimed || !linkProjectEventDecisionItem(ctx(), claimed).ok) {
      throw new Error('expected a linked dispatch claim')
    }
    const observation = await observe()()
    if (!observation.ok) {
      throw new Error('fixture could not observe the head')
    }
    const runId = queueForgeItemRun(ctx(), observation.itemId, PROJECT_EVENT_DISPATCH_RUN_REASON)
    if (runId === null || !transitionForgeRun(ctx(), runId, { to: 'running' }).ok) {
      throw new Error('fixture could not start the interrupted run')
    }
    let launches = 0
    const launch = createForgeProjectEventAgentLaunch(ledger, launchPorts(wiringProbe()))
    const launchAgent = async (input: Parameters<typeof launch>[0]) => {
      launches += 1
      return launch(input)
    }
    const launched = await launchAgent({
      itemId: observation.itemId,
      repoId: claimed.repoId,
      runId,
      prompt: 'Run the project event.\n'
    })
    if (!launched.ok || launched.sessionId === null) {
      throw new Error('fixture could not launch the interrupted dispatch')
    }
    const sessionId = launched.sessionId
    const launchesBeforeRecovery = launches
    expect(launchesBeforeRecovery).toBe(1)
    expect(runs()).toEqual([expect.objectContaining({ state: 'running', session_id: sessionId })])

    recoverInterruptedForgeWork(ctx())

    expect(launches).toBe(launchesBeforeRecovery)
    expect(decisionRow()).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'dispatch-unverifiable'
    })
    expect(deliveryRow(1)).toMatchObject({
      state: 'failed',
      last_error_code: 'dispatch-unverifiable'
    })
    expect(runs()).toEqual([
      expect.objectContaining({
        state: 'unverifiable',
        error: 'unknown-outcome',
        session_id: sessionId
      })
    ])
    // Recovery must not hand the unverifiable dispatch back to the launcher.
    expect(
      await drainProjectEventActions(ctx(), {
        limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
        observeContext: observe(),
        launchAgentFactory: () => launchAgent,
        launchAgentLedger: ledger
      })
    ).toEqual({ executed: 0, failed: 0, capped: false })
    expect(launches).toBe(launchesBeforeRecovery)
  })
})
