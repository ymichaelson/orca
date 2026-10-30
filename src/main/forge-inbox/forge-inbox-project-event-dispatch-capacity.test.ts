import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { linkProjectEventBinding } from './forge-inbox-project-event-link'
import { observeProjectEventBindingHead } from './forge-inbox-project-event-observation'
import { createForgeWorkerScheduler } from './forge-inbox-worker-scheduler'
import {
  createFakeCancelHost,
  openDispatchLedger,
  updatePolicy,
  type DispatchLedgerFixture
} from './forge-inbox-project-event-run-cancel-test-kit'
import { createForgeProjectEventRunWatch } from './forge-inbox-project-event-run-watch'
import { readForgeProtectedTurnProof } from './forge-inbox-protected-turn-proof'
import {
  createFakeTerminalRuntime,
  PTY_A,
  seedTerminalRun
} from './forge-inbox-project-event-terminal-test-kit'
import { createForgeProjectEventTerminalObserver } from './forge-inbox-project-event-terminal-observer'
import type { ProjectEventDecisionAction } from '../../shared/project-event-decision'
import { readDispatchConfirmation } from './forge-inbox-dispatch-confirmation'
import { claimForgeNotifications } from './forge-inbox-notification-claim'
import {
  claimProjectEventAction,
  getProjectEventActionSchedule
} from './forge-inbox-project-event-action'
import { drainProjectEventActions } from './forge-inbox-project-event-action-drain'
import {
  createForgeProjectEventAgentLaunch,
  type ProjectEventAgentLaunchPorts
} from './forge-inbox-project-event-agent-launch'
import {
  claimProjectEventDecision,
  decideProjectEventDelivery
} from './forge-inbox-project-event-decision'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { projectEventQuestionDecision } from './forge-inbox-project-event-question-test-kit'
import { recordRunTerminalExit } from './forge-inbox-project-event-run-terminal-state'
import { transitionForgeRun } from './forge-inbox-runs'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('project event execution capacity', () => {
  let fixture: DispatchLedgerFixture
  let prompts: { sessionId: string; text: string }[]
  let ports: ProjectEventAgentLaunchPorts

  beforeEach(() => {
    fixture = openDispatchLedger()
    prompts = []
    ports = {
      runtime: {
        requireStore: () => ({
          getSettings: () => ({ experimentalNativeChat: true }),
          getRepo: (repoId) => ({ path: `/${repoId}`, connectionId: null })
        }),
        getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
        ensureStructuredAgentSessionHost: async () => {},
        resolveRuntimeFileTarget: async (selector) => {
          const id = selector.replace(/^id:/, '')
          const repoId = id.split('::')[0] ?? ''
          return { worktree: { path: `/${repoId}`, id, repoId }, executionHostId: 'local' }
        },
        launchAgentTerminal: async () => {
          throw new Error('expected structured launch')
        }
      },
      createStructuredSession: async (args) => ({
        ok: true,
        value: { sessionId: args.envelope.sessionId, fence: 1 }
      }),
      deliverStructuredPrompt: async ({ sessionId, text, clientMessageId }) => {
        prompts.push({ sessionId, text })
        return clientMessageId
      }
    }
  })

  afterEach(() => fixture.dispose())

  function ctx() {
    return fixture.ledger.ledgerContext()
  }

  function recordBody(
    body: Buffer,
    eventKind: string,
    repoId = 'repo-1',
    action: ProjectEventDecisionAction = 'dispatch_agent'
  ) {
    const link = fixture.ledger.getProjectEventRepoLink(repoId)
    if (!link) {
      throw new Error('missing fixture link')
    }
    const binding = fixture.ledger.getProjectBinding(link.bindingId)
    if (!binding) {
      throw new Error('missing fixture binding')
    }
    const admitted = admitProjectEventDelivery(ctx(), FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId: link.bindingId,
      projectPath: binding.gitlabPath,
      policyGeneration: fixture.ledger.getProjectEventPolicy(repoId)?.generation ?? 0,
      policyEnabled: true,
      eventKind,
      dedupeKey: randomUUID(),
      correlation: { eventUuid: null, configUuid: null },
      body
    })
    if (!admitted.ok) {
      throw new Error(`admission refused: ${admitted.reason}`)
    }
    const claim = claimProjectEventDecision(ctx())
    if (
      !claim ||
      !decideProjectEventDelivery(
        ctx(),
        admitted.deliveryId,
        projectEventQuestionDecision(action),
        claim
      ).ok
    ) {
      throw new Error('fixture decision failed')
    }
    return admitted.deliveryId
  }

  function recordPush(
    sha: string,
    repoId = 'repo-1',
    action: ProjectEventDecisionAction = 'dispatch_agent',
    extra: Record<string, unknown> = {}
  ) {
    const link = fixture.ledger.getProjectEventRepoLink(repoId)
    const binding = link && fixture.ledger.getProjectBinding(link.bindingId)
    if (!binding) {
      throw new Error('missing fixture binding')
    }
    return recordBody(
      Buffer.from(
        JSON.stringify({
          object_kind: 'push',
          project_id: binding.gitlabProjectId,
          project: { id: binding.gitlabProjectId, path_with_namespace: binding.gitlabPath },
          ref: 'refs/heads/main',
          before: '0'.repeat(40),
          after: sha,
          commits: [],
          total_commits_count: 0,
          ...extra
        })
      ),
      'Push Hook',
      repoId,
      action
    )
  }

  function recordMergeRequest(iid: number) {
    return recordBody(
      Buffer.from(
        JSON.stringify({
          object_kind: 'merge_request',
          project: { id: 3 },
          merge_request: { iid, title: `Change ${iid}`, state: 'opened' },
          object_attributes: { action: 'update', last_commit: { id: SHA_A } }
        })
      ),
      'Merge Request Hook'
    )
  }

  function actionDeps() {
    return {
      limits: FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS,
      launchAgentFactory: () => createForgeProjectEventAgentLaunch(fixture.ledger, ports),
      launchAgentLedger: fixture.ledger
    }
  }

  function drain() {
    return drainProjectEventActions(ctx(), actionDeps())
  }

  function addProject(
    repoId: string,
    host: string,
    id: number,
    path: string,
    bindingId: string = randomUUID()
  ) {
    upsertProjectBinding(ctx(), {
      bindingId,
      projectPath: `/${repoId}`,
      gitlabHost: host,
      gitlabPath: path,
      gitlabProjectId: id,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx(), { repoId, bindingId })
    updatePolicy(fixture.ledger, repoId, { enabled: true, agentId: 'claude', rules: 'rules' })
    return bindingId
  }

  async function flushMicrotasks() {
    for (let index = 0; index < 40; index++) {
      await Promise.resolve()
    }
  }

  async function observe(claim: Parameters<typeof observeProjectEventBindingHead>[1]) {
    return observeProjectEventBindingHead(ctx(), claim, {
      exec: async (args) => {
        const match = /^projects\/3\/merge_requests\/(\d+)$/.exec(args[4] ?? '')
        const iid = Number(match?.[1])
        const body = match
          ? {
              iid,
              state: 'opened',
              title: `Change ${iid}`,
              description: 'Description',
              target_branch: 'main',
              source_branch: `feature-${iid}`,
              draft: false,
              sha: SHA_A,
              diff_refs: { base_sha: SHA_B, head_sha: SHA_A, start_sha: SHA_B },
              author: { username: 'test' },
              reviewers: [],
              assignees: [],
              updated_at: '2026-10-01T10:00:00.000Z'
            }
          : []
        return {
          stdout: `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
          stderr: ''
        }
      }
    })
  }

  function decision(deliveryId: number) {
    return ctx()
      .db.prepare(`SELECT d.action_state, d.last_error_code, d.run_id, w.body,
      w.finished_at FROM project_event_decisions d JOIN webhook_deliveries w ON w.id = d.delivery_id
      WHERE d.delivery_id = ?`)
      .get(deliveryId)
  }

  it('keeps a second distinct push queued with its body until the first execution ends', async () => {
    recordPush(SHA_A)
    await drain()
    const waiting = recordPush(SHA_B)
    expect(await drain()).toEqual({ executed: 0, failed: 0, capped: false })
    expect(prompts).toHaveLength(1)
    expect(decision(waiting)).toMatchObject({
      action_state: 'queued',
      last_error_code: null,
      finished_at: null
    })
    expect(decision(waiting)?.body).toBeInstanceOf(Uint8Array)
    expect(getProjectEventActionSchedule(ctx())).toEqual({
      pending: 0,
      needsAuth: 0,
      nextAttemptAtMs: null
    })
    expect(claimProjectEventAction(ctx())).toBeNull()

    expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
    expect(getProjectEventActionSchedule(ctx()).pending).toBe(1)
    await drain()
    expect(prompts).toHaveLength(2)
    expect(decision(waiting)).toMatchObject({
      action_state: 'done',
      run_id: 2,
      body: new Uint8Array()
    })
  })

  it('does not let a busy project starve another project or a non-dispatch action', async () => {
    recordPush(SHA_A)
    await drain()
    const busy = recordPush(SHA_B)
    const other = recordPush(SHA_A, 'repo-2')
    const wait = recordPush('c'.repeat(40), 'repo-1', 'wait')
    expect(getProjectEventActionSchedule(ctx()).pending).toBe(2)
    expect(await drain()).toEqual({ executed: 2, failed: 0, capped: false })
    expect(prompts).toHaveLength(2)
    expect(decision(busy)?.action_state).toBe('queued')
    expect(decision(other)?.action_state).toBe('done')
    expect(decision(wait)?.action_state).toBe('awaiting-event')
  })

  it('keeps unknown-outcome execution in capacity after a policy change', async () => {
    recordPush(SHA_A)
    await drain()
    expect(transitionForgeRun(ctx(), 1, { to: 'unverifiable', error: 'unknown-outcome' }).ok).toBe(
      true
    )
    updatePolicy(fixture.ledger, 'repo-1', { rules: 'New generation' })
    const waiting = recordPush(SHA_B)
    await drain()
    expect(prompts).toHaveLength(1)
    expect(decision(waiting)?.action_state).toBe('queued')
  })

  it('releases an exited terminal without pretending its task or effect succeeded', async () => {
    const runId = seedTerminalRun(fixture.ledger)
    const waiting = recordPush(SHA_A)
    await drain()
    expect(prompts).toHaveLength(0)
    expect(decision(waiting)?.action_state).toBe('queued')
    const run = fixture.ledger.getRun(runId)
    if (!run) {
      throw new Error('missing terminal run')
    }
    expect(
      recordRunTerminalExit(ctx(), { runId, itemId: run.itemId }, { kind: 'exited', value: 0 })
    ).toBe(true)
    expect(readDispatchConfirmation(ctx(), runId)?.state).toBe('unconfirmable')
    await drain()
    expect(prompts).toHaveLength(1)
    expect(fixture.ledger.getRun(runId)?.state).toBe('unverifiable')
  })

  it('coalesces queued pushes to the newest known head while retaining every event', async () => {
    recordPush(SHA_A)
    await drain()
    const older = recordPush(SHA_B)
    const newestSha = 'c'.repeat(40)
    const newest = recordPush(newestSha)
    await drain()
    expect(prompts).toHaveLength(1)
    expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
    await drain()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toContain(newestSha)
    expect(decision(older)?.action_state).toBe('done')
    expect(decision(newest)?.action_state).toBe('queued')
    expect(transitionForgeRun(ctx(), 2, { to: 'succeeded' }).ok).toBe(true)
    await drain()
    expect(decision(newest)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'already-dispatched'
    })
    expect(prompts).toHaveLength(2)
    expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3)
    expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(2)
  })

  it.each(['notify', 'record_only', 'wait'] as const)(
    'dispatches queued work at the newest head after a later %s decision',
    async (action) => {
      recordPush(SHA_A)
      await drain()
      const waiting = recordPush(SHA_B)
      const newestSha = 'c'.repeat(40)
      recordPush(newestSha, 'repo-1', action)
      await drain()
      if (action === 'notify') {
        expect(claimForgeNotifications(ctx()).notifications).toMatchObject([
          { reason: 'project-event', trigger: expect.stringMatching(/^v2:[a-f0-9]{64}$/) }
        ])
      }
      expect(prompts).toHaveLength(1)
      expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
      await drain()
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toContain(newestSha)
      expect(prompts[1]?.text).toContain('refs/heads/main')
      expect(prompts[1]?.text).not.toContain(SHA_B)
      expect(decision(waiting)?.action_state).toBe('done')
      expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3)
      expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(2)
    }
  )

  it('uses the latest event identity when two pushes have the same head', async () => {
    recordPush(SHA_A)
    await drain()
    const waiting = recordPush(SHA_B, 'repo-1', 'dispatch_agent', {
      before: 'd'.repeat(40),
      commits: [{ id: SHA_B, message: 'stale commit' }],
      total_commits_count: 1
    })
    recordPush(SHA_B, 'repo-1', 'notify', {
      before: 'e'.repeat(40),
      commits: [{ id: SHA_B, message: 'new commit' }],
      total_commits_count: 1
    })
    await drain()
    expect(claimForgeNotifications(ctx()).notifications).toMatchObject([
      { reason: 'project-event', trigger: expect.stringMatching(/^v2:[a-f0-9]{64}$/) }
    ])
    expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
    await drain()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toContain(SHA_B)
    expect(prompts[1]?.text).toContain('refs/heads/main')
    expect(prompts[1]?.text).not.toContain('d'.repeat(40))
    expect(prompts[1]?.text).not.toContain('stale commit')
    expect(decision(waiting)?.action_state).toBe('done')
    expect(transitionForgeRun(ctx(), 2, { to: 'succeeded' }).ok).toBe(true)
    const duplicate = recordPush(SHA_B)
    await drain()
    expect(decision(duplicate)).toMatchObject({
      action_state: 'blocked',
      last_error_code: 'already-dispatched'
    })
    expect(prompts).toHaveLength(2)
    expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(4)
  })

  it('bounds the host to two projects, counting canonical host and numeric project identity', async () => {
    addProject('repo-3', 'other.gitlab.test', 3, 'group/demo')
    recordPush(SHA_A)
    recordPush(SHA_A, 'repo-2')
    const waiting = recordPush(SHA_A, 'repo-3')
    expect(await drain()).toEqual({ executed: 2, failed: 0, capped: false })
    expect(prompts).toHaveLength(2)
    expect(decision(waiting)?.action_state).toBe('queued')
    expect(getProjectEventActionSchedule(ctx()).pending).toBe(0)
    expect(transitionForgeRun(ctx(), 2, { to: 'succeeded' }).ok).toBe(true)
    await drain()
    expect(prompts).toHaveLength(3)
    expect(decision(waiting)?.action_state).toBe('done')
  })

  it('uses frozen numeric identity when the project path changes', async () => {
    recordPush(SHA_A)
    await drain()
    const link = fixture.ledger.getProjectEventRepoLink('repo-1')
    if (!link) {
      throw new Error('missing fixture link')
    }
    addProject('repo-1', 'gitlab.test', 3, 'renamed/demo', link.bindingId)
    const waiting = recordPush(SHA_B)
    await drain()
    expect(prompts).toHaveLength(1)
    expect(decision(waiting)?.action_state).toBe('queued')
    expect(readDispatchConfirmation(ctx(), 1)).toMatchObject({
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 3
    })
    expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
    await drain()
    expect(prompts).toHaveLength(2)
    expect(decision(waiting)?.action_state).toBe('done')
  })

  it('atomically rechecks project capacity after concurrent observations of different items', async () => {
    recordMergeRequest(7)
    const waiting = recordMergeRequest(8)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let observing = 0
    const deps = {
      ...actionDeps(),
      observeContext: async (claim: Parameters<typeof observe>[0]) => {
        observing++
        await gate
        return observe(claim)
      }
    }
    const first = drainProjectEventActions(ctx(), deps)
    const second = drainProjectEventActions(ctx(), deps)
    expect(observing).toBe(2)
    release()
    const outcomes = await Promise.all([first, second])
    expect(outcomes.reduce((sum, result) => sum + result.executed, 0)).toBe(1)
    expect(outcomes.reduce((sum, result) => sum + result.failed, 0)).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(decision(waiting)?.action_state).toBe('queued')
    expect(decision(waiting)?.body).toBeInstanceOf(Uint8Array)
    expect(
      ctx().db.prepare('SELECT COUNT(DISTINCT item_id) AS n FROM project_event_decisions').get()?.n
    ).toBe(2)
    expect(ctx().db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1)
    expect(transitionForgeRun(ctx(), 1, { to: 'succeeded' }).ok).toBe(true)
    await drainProjectEventActions(ctx(), deps)
    expect(prompts).toHaveLength(2)
  })

  it('leaves stopping old-generation work in capacity until its own terminal verdict', async () => {
    recordPush(SHA_A)
    await drain()
    updatePolicy(fixture.ledger, 'repo-1', { rules: 'New rules' })
    const waiting = recordPush(SHA_B)
    const stopping = fixture.ledger.getRun(1)
    expect(stopping?.state).toBe('running')
    expect(
      ctx().db.prepare('SELECT cancel_requested_at FROM runs WHERE id = 1').get()
        ?.cancel_requested_at
    ).toBeTypeOf('number')
    await drain()
    expect(prompts).toHaveLength(1)
    expect(decision(waiting)?.action_state).toBe('queued')
    expect(transitionForgeRun(ctx(), 1, { to: 'cancelled' }).ok).toBe(true)
    await drain()
    expect(prompts).toHaveLength(2)
  })

  it('keeps busy work queued across restart without implicitly relaunching the first run', async () => {
    recordPush(SHA_A)
    await drain()
    const waiting = recordPush(SHA_B)
    await drain()
    fixture.reopen()
    await drain()
    expect(prompts).toHaveLength(1)
    expect(fixture.ledger.getRun(1)).toMatchObject({
      state: 'unverifiable',
      error: 'unknown-outcome'
    })
    expect(decision(waiting)).toMatchObject({ action_state: 'queued', finished_at: null })
    expect(decision(waiting)?.body).toBeInstanceOf(Uint8Array)
    expect(getProjectEventActionSchedule(ctx()).pending).toBe(0)
  })

  it('wakes on its own turn completion commit and arms no retry timer while busy', async () => {
    vi.useFakeTimers()
    const fake = createFakeCancelHost()
    const watch = createForgeProjectEventRunWatch({
      ledger: fixture.ledger,
      readTurnProof: (session, message) => readForgeProtectedTurnProof(fake.host, session, message),
      subscribeTurnCompletions: fake.subscribeTurnCompletions
    })
    ports.runWatch = watch
    const deliver = ports.deliverStructuredPrompt
    ports.deliverStructuredPrompt = async (args) => {
      fake.control.sessionId = args.sessionId
      const message = await deliver(args)
      if (message === null) {
        throw new Error('missing delivered message')
      }
      fake.startTurn({ messageId: message, turnId: `turn-${prompts.length}` })
      return message
    }
    let drains = 0
    const deps = actionDeps()
    const scheduler = createForgeWorkerScheduler({
      now: () => fixture.ledger.nowMs(),
      readSchedule: () => getProjectEventActionSchedule(ctx()),
      drain: (signal) => {
        drains++
        return drainProjectEventActions(ctx(), deps, signal)
      }
    })
    const unsubscribe = fixture.ledger.onCommitted(() => scheduler.wake())
    try {
      recordPush(SHA_A)
      await flushMicrotasks()
      await scheduler.settled()
      const waiting = recordPush(SHA_B)
      await flushMicrotasks()
      await scheduler.settled()
      expect(prompts).toHaveLength(1)
      expect(scheduler.status()).toEqual({ draining: false, timerAtMs: null })
      const before = drains
      await vi.advanceTimersByTimeAsync(60_000)
      expect(drains).toBe(before)
      const message = ctx()
        .db.prepare('SELECT dispatch_client_message_id FROM runs WHERE id = 1')
        .get()?.dispatch_client_message_id
      if (typeof message !== 'string') {
        throw new Error('missing dispatched turn')
      }
      fake.completeTurn(message, 'success')
      await flushMicrotasks()
      await scheduler.settled()
      expect(prompts).toHaveLength(2)
      expect(fixture.ledger.getRun(1)?.state).toBe('succeeded')
      expect(decision(waiting)?.action_state).toBe('done')
    } finally {
      unsubscribe()
      await scheduler.stop()
      watch.dispose()
      vi.useRealTimers()
    }
  })

  it('does not free a disconnected terminal slot, but its actual exit commit does', async () => {
    vi.useFakeTimers()
    const fake = createFakeTerminalRuntime()
    fake.terminals.set('handle-1', PTY_A)
    const runId = seedTerminalRun(fixture.ledger)
    const observer = createForgeProjectEventTerminalObserver({
      ledger: fixture.ledger,
      runtime: fake.runtime,
      giveUpCooldownMs: 0
    })
    try {
      await flushMicrotasks()
      expect(fake.waiterCount()).toBe(1)
      const waiting = recordPush(SHA_A)
      fake.disconnect('handle-1')
      await flushMicrotasks()
      await drain()
      expect(prompts).toHaveLength(0)
      expect(decision(waiting)?.action_state).toBe('queued')
      expect(getProjectEventActionSchedule(ctx()).pending).toBe(0)
      observer.wake()
      await flushMicrotasks()
      expect(fake.waiterCount()).toBe(1)
      fake.exit('handle-1', 0, { kind: 'exited', exitCode: 0 })
      await flushMicrotasks()
      expect(readDispatchConfirmation(ctx(), runId)?.state).toBe('unconfirmable')
      expect(getProjectEventActionSchedule(ctx()).pending).toBe(1)
      await drain()
      expect(prompts).toHaveLength(1)
      expect(fixture.ledger.getRun(runId)?.state).toBe('unverifiable')
    } finally {
      await observer.stop()
      vi.useRealTimers()
    }
  })
})
