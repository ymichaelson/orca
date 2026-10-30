import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import type { SecretStore } from '../../shared/secret-store'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { openForgeInboxDatabase } from './forge-inbox-database'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { fakeStore } from './forge-inbox-project-binding-test-fixture'
import { admitProjectEventDelivery } from './forge-inbox-project-event-delivery'
import { createForgeWorkerScheduler } from './forge-inbox-worker-scheduler'
import {
  getProjectEventDecisionSchedule,
  recoverInterruptedProjectEventDecisions
} from './forge-inbox-project-event-decision'
import {
  linkProjectEventBinding,
  removeProjectEventRepoLink
} from './forge-inbox-project-event-link'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import { drainProjectEventDecisions } from './forge-inbox-project-event-decision-drain'
import { FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS } from './forge-inbox-webhook-queue'

const RULES = '合并请求需要评审。'
const BODY = Buffer.from('{"object_kind":"merge_request","project":{"id":3}}')

const decided = (action: 'record_only' | 'dispatch_agent'): ProjectEventDecisionResult => ({
  ok: true,
  provider: 'jev',
  model: 'jev-1',
  action,
  confidence: 0.9,
  probabilities: {
    record_only: action === 'record_only' ? 0.9 : 0.02,
    notify: 0.02,
    wait: 0.02,
    fetch_context: 0.02,
    dispatch_agent: action === 'dispatch_agent' ? 0.9 : 0.02,
    ask_user: 0.02
  },
  usage: { inputTokens: 12, outputTokens: 3 }
})

describe('project event decision drain', () => {
  let root: string
  let store: SecretStore
  let ctx: ForgeLedgerContext
  let bindingId: string
  const seen: { rules: string; event: Record<string, unknown> }[] = []

  const admit = (key: string): void => {
    const admitted = admitProjectEventDelivery(ctx, FORGE_WEBHOOK_DEFAULT_QUEUE_LIMITS, {
      bindingId,
      projectPath: 'group/demo',
      policyGeneration: 1,
      policyEnabled: true,
      eventKind: 'Merge Request Hook',
      dedupeKey: key,
      correlation: { eventUuid: null, configUuid: null },
      body: BODY
    })
    if (!admitted.ok) {
      throw new Error(`fixture could not admit: ${admitted.reason}`)
    }
  }

  beforeEach(() => {
    seen.length = 0
    root = mkdtempSync(join(tmpdir(), 'forge-decision-drain-'))
    let clock = 1000
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    store = fakeStore()
    ctx = { db: opened.db, hostId: opened.hostId, now: () => ++clock, secretStore: () => store }
    bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
    updateProjectEventPolicy(ctx, {
      repoId: 'repo-1',
      expectedGeneration: 0,
      patch: { enabled: true, rules: RULES }
    })
  })

  afterEach(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('asks the decision client with the project rules and finishes a delivery that needs nothing more', async () => {
    admit('delivery-1')

    const drained = await drainProjectEventDecisions(ctx, async (input) => {
      seen.push({ rules: input.rules, event: { ...input.event } })
      return decided('record_only')
    })

    expect(drained).toEqual({ decided: 1, failed: 0, capped: false })
    expect(seen).toMatchObject([
      {
        rules: RULES,
        event: {
          eventKind: 'Merge Request Hook',
          kind: 'merge_request',
          missing: expect.arrayContaining(['title', 'sha'])
        }
      }
    ])
    expect(
      ctx.db.prepare('SELECT state, length(body) AS bytes FROM webhook_deliveries').get()
    ).toEqual({ state: 'done', bytes: 0 })
    expect(ctx.db.prepare('SELECT action FROM project_event_decisions').get()).toEqual({
      action: 'record_only'
    })
  })

  it('leaves the delivery pending when the decision fails, so a later drain can retry it', async () => {
    admit('delivery-1')

    const first = await drainProjectEventDecisions(ctx, async () => ({
      ok: false,
      code: 'rate-limited'
    }))
    ctx.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0').run()
    const second = await drainProjectEventDecisions(ctx, async () => decided('dispatch_agent'))

    expect(first).toEqual({ decided: 0, failed: 1, capped: false })
    expect(second).toEqual({ decided: 1, failed: 0, capped: false })
    expect(ctx.db.prepare('SELECT state FROM webhook_deliveries').get()).toEqual({
      state: 'pending'
    })
    expect(ctx.db.prepare('SELECT action FROM project_event_decisions').all()).toEqual([
      { action: 'dispatch_agent' }
    ])
  })

  it('claims transactionally across concurrent drains', async () => {
    admit('concurrent')
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const provider = async (): Promise<ProjectEventDecisionResult> => {
      calls += 1
      await waiting
      return decided('record_only')
    }
    const first = drainProjectEventDecisions(ctx, provider)
    const opened = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1')
    const other = { ...ctx, db: opened.db }
    const second = drainProjectEventDecisions(other, provider)
    release()
    await Promise.all([first, second])
    opened.db.close()
    expect(calls).toBe(1)
    expect(ctx.db.prepare('SELECT count(*) AS n FROM project_event_decisions').get()).toEqual({
      n: 1
    })
  })

  it('fences a paid response after policy edit', async () => {
    admit('edit')
    await drainProjectEventDecisions(ctx, async () => {
      updateProjectEventPolicy(ctx, {
        repoId: 'repo-1',
        expectedGeneration: 1,
        patch: { rules: 'New rules' }
      })
      return decided('dispatch_agent')
    })
    expect(
      ctx.db.prepare('SELECT state, length(body) AS bytes FROM webhook_deliveries').get()
    ).toMatchObject({ state: 'pending' })
    expect(
      ctx.db.prepare('SELECT superseded FROM project_event_decisions ORDER BY id LIMIT 1').get()
    ).toEqual({ superseded: 1 })
  })

  it.each(['disable', 'unlink', 'relink'] as const)(
    'fences %s while a response is suspended',
    async (change) => {
      admit(change)
      let calls = 0
      let release!: () => void
      const suspended = new Promise<void>((resolve) => {
        release = resolve
      })
      const draining = drainProjectEventDecisions(ctx, async () => {
        calls += 1
        await suspended
        return decided(calls === 1 ? 'record_only' : 'dispatch_agent')
      })
      if (change === 'disable') {
        updateProjectEventPolicy(ctx, {
          repoId: 'repo-1',
          expectedGeneration: 1,
          patch: { enabled: false }
        })
      } else {
        removeProjectEventRepoLink(ctx, 'repo-1')
        if (change === 'relink') {
          linkProjectEventBinding(ctx, { repoId: 'repo-1', bindingId })
        }
      }
      release()
      await draining
      expect(
        ctx.db.prepare('SELECT state, length(body) AS bytes FROM webhook_deliveries').get()
      ).toMatchObject({
        state: change === 'unlink' ? 'parked' : change === 'disable' ? 'failed' : 'pending',
        bytes: change === 'disable' ? 0 : BODY.length
      })
      expect(
        ctx.db.prepare('SELECT superseded FROM project_event_decisions ORDER BY id LIMIT 1').get()
      ).toEqual({ superseded: 1 })
      expect(calls).toBe(change === 'relink' ? 2 : 1)
    }
  )

  it('does not retry before its durable due date, including after reopen, and wakes by timer', async () => {
    vi.useFakeTimers()
    let now = 100_000
    ctx.now = () => now
    admit('retry')
    await drainProjectEventDecisions(ctx, async () => ({
      ok: false,
      code: 'rate-limited',
      retryAfterMs: 60_000
    }))
    expect(getProjectEventDecisionSchedule(ctx).nextAttemptAtMs).toBe(160_000)
    ctx.db.close()
    ctx.db = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-1').db
    let calls = 0
    const scheduler = createForgeWorkerScheduler({
      now: () => now,
      readSchedule: () => getProjectEventDecisionSchedule(ctx),
      drain: (signal) =>
        drainProjectEventDecisions(
          ctx,
          async () => {
            calls += 1
            return decided('record_only')
          },
          signal
        )
    })
    try {
      scheduler.wake()
      await scheduler.settled()
      expect(calls).toBe(0)
      expect(scheduler.status()).toEqual({ draining: false, timerAtMs: 160_000 })
      now = 160_000
      await vi.advanceTimersByTimeAsync(60_000)
      await scheduler.settled()
      expect(calls).toBe(1)
      expect(ctx.db.prepare('SELECT state FROM webhook_deliveries').get()).toEqual({
        state: 'done'
      })
    } finally {
      await scheduler.stop()
      vi.useRealTimers()
    }
  })

  it('continues explicitly beyond the eight-item batch without another commit wake', async () => {
    for (let i = 0; i < 19; i += 1) {
      admit(`batch-${i}`)
    }
    const scheduler = createForgeWorkerScheduler({
      now: ctx.now,
      readSchedule: () => getProjectEventDecisionSchedule(ctx),
      drain: (signal) => drainProjectEventDecisions(ctx, async () => decided('record_only'), signal)
    })
    scheduler.wake()
    await scheduler.settled()
    await scheduler.stop()
    expect(ctx.db.prepare('SELECT count(*) AS n FROM project_event_decisions').get()).toEqual({
      n: 19
    })
  })

  it('blocks capped and auth failures durably instead of replaying on unrelated wakes', async () => {
    admit('bad-auth')
    await drainProjectEventDecisions(ctx, async () => ({ ok: false, code: 'unauthorized' }))
    const result = await drainProjectEventDecisions(ctx, async () => {
      throw new Error('must not call')
    })
    expect(result.failed).toBe(0)
    expect(getProjectEventDecisionSchedule(ctx).pending).toBe(0)
    expect(
      ctx.db
        .prepare(
          'SELECT state, decision_state, last_error_code, length(body) AS bytes FROM webhook_deliveries'
        )
        .get()
    ).toEqual({
      state: 'failed',
      decision_state: 'blocked',
      last_error_code: 'unauthorized',
      bytes: 0
    })
  })

  it('caps transient failures without marking the event handled', async () => {
    admit('capped')
    for (let i = 0; i < 5; i += 1) {
      ctx.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0').run()
      await drainProjectEventDecisions(ctx, async () => ({ ok: false, code: 'network' }))
    }
    expect(getProjectEventDecisionSchedule(ctx).pending).toBe(0)
    expect(
      ctx.db
        .prepare(
          'SELECT state, decision_state, attempts, length(body) AS bytes FROM webhook_deliveries'
        )
        .get()
    ).toMatchObject({
      state: 'failed',
      decision_state: 'blocked',
      attempts: 5,
      // The attempt cap makes it terminal, so its payload must not occupy the queue for good.
      bytes: 0
    })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM project_event_decisions').get()).toEqual({
      n: 0
    })
  })

  it('parks an unlinked oldest row without starving runnable bindings', async () => {
    admit('orphan')
    ctx.db.prepare("UPDATE webhook_deliveries SET binding_id = 'missing'").run()
    admit('runnable')
    const result = await drainProjectEventDecisions(ctx, async () => decided('record_only'))
    expect(result.decided).toBe(1)
    expect(
      ctx.db.prepare('SELECT state, decision_state FROM webhook_deliveries ORDER BY id').all()
    ).toEqual([
      { state: 'parked', decision_state: 'blocked' },
      { state: 'done', decision_state: 'decided' }
    ])
  })

  it('forwards abort during a request and conservatively recovers an interrupted claim', async () => {
    admit('abort')
    const abort = new AbortController()
    const running = drainProjectEventDecisions(
      ctx,
      async (_input, signal) => {
        expect(signal).toBe(abort.signal)
        abort.abort()
        return decided('record_only')
      },
      abort.signal
    )
    await running
    expect(ctx.db.prepare('SELECT count(*) AS n FROM project_event_decisions').get()).toEqual({
      n: 0
    })
    recoverInterruptedProjectEventDecisions(ctx)
    // Nothing was decided, so the row must become runnable again instead of idling as blocked+pending.
    expect(
      ctx.db
        .prepare(
          'SELECT state, decision_state, last_error_code, length(body) AS bytes FROM webhook_deliveries'
        )
        .get()
    ).toEqual({
      state: 'pending',
      decision_state: 'queued',
      last_error_code: 'interrupted-decision',
      bytes: BODY.length
    })
    expect(getProjectEventDecisionSchedule(ctx).pending).toBe(1)

    await drainProjectEventDecisions(ctx, async () => decided('record_only'))
    expect(
      ctx.db.prepare('SELECT state, decision_state, last_error_code FROM webhook_deliveries').get()
    ).toEqual({
      state: 'done',
      decision_state: 'decided',
      last_error_code: 'item-identity-missing'
    })
  })

  it('passes bounded meaningful body facts without trusting payload URL authority', async () => {
    admit('facts')
    ctx.db.prepare('UPDATE webhook_deliveries SET body = ?').run(
      Buffer.from(
        JSON.stringify({
          object_kind: 'merge_request',
          project: { web_url: 'https://evil.test', id: 999 },
          object_attributes: {
            action: 'update',
            id: 50,
            iid: 7,
            title: 'Review me',
            description: 'x'.repeat(100_000),
            last_commit: { id: 'abc123' },
            source_branch: 'feature',
            target_branch: 'main',
            state: 'opened'
          }
        })
      )
    )
    await drainProjectEventDecisions(ctx, async (input) => {
      expect(input.event).toMatchObject({
        kind: 'merge_request',
        action: 'update',
        iid: 7,
        sha: 'abc123',
        title: 'Review me',
        text: 'x'.repeat(4096),
        truncated: ['text']
      })
      expect(input.context).toMatchObject({
        gitlabHost: 'gitlab.test',
        gitlabProjectId: 3,
        projectPath: '/repo',
        policyGeneration: 1
      })
      expect(JSON.stringify(input)).not.toContain('evil.test')
      expect(JSON.stringify(input).length).toBeLessThan(8000)
      return decided('dispatch_agent')
    })
    expect(
      ctx.db
        .prepare(
          'SELECT input_version, length(input_fingerprint) AS bytes FROM project_event_decisions'
        )
        .get()
    ).toEqual({ input_version: 4, bytes: 64 })
  })

  it('stops at one batch of eight and leaves the rest due for the next drain', async () => {
    for (let i = 1; i <= 9; i++) {
      admit(`delivery-${i}`)
    }

    const first = await drainProjectEventDecisions(ctx, async () => decided('record_only'))
    const second = await drainProjectEventDecisions(ctx, async () => decided('record_only'))

    expect(first).toEqual({ decided: 8, failed: 0, capped: true })
    expect(second).toEqual({ decided: 1, failed: 0, capped: false })
    expect(getProjectEventDecisionSchedule(ctx).pending).toBe(0)
  })

  it('never sends a delivery the retired instance worker owns', async () => {
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (host_id, instance_id, project_id, dedupe_key, event_kind,
           config_revision, admitted_at, state, body)
         VALUES (?, 'gitlab-main', '42', 'msg:old', 'Merge Request Hook', 1, 1, 'pending', x'01')`
      )
      .run(ctx.hostId)

    const drained = await drainProjectEventDecisions(ctx, async () => decided('record_only'))

    expect(drained).toEqual({ decided: 0, failed: 0, capped: false })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM project_event_decisions').get()).toMatchObject(
      {
        n: 0
      }
    )
  })
})
