import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeAnalysisResult } from '../../shared/forge-inbox-types'
import { createForgeInboxCoordinator, type ForgeAnalysisOutcome } from './forge-inbox-coordinator'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { ForgeObservationInput } from './forge-inbox-observation'
import {
  createWebhookHarness,
  INSTANCE_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const PROJECT = { instanceId: INSTANCE_ID, projectId: '42' }

describe('forge inbox analysis coordinator', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let runId: number

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({
          projects: [
            {
              projectId: '42',
              repoId: 'repo-1',
              workspaceId: 'ws-1',
              agentId: 'codex',
              model: 'gpt-fake',
              enabled: true,
              automaticAnalysis: true
            }
          ]
        })
      ])
    )
    runId = queueReviewRequest()
  })
  afterEach(() => harness.dispose())

  function queueReviewRequest(): number {
    const input: ForgeObservationInput = {
      hostId: 'host-a',
      ...SCOPE,
      projectId: '42',
      kind: 'merge_request',
      iid: 7,
      dedupeKey: 'delivery-1',
      eventKind: 'merge_request.review_requested',
      payload: { token: 'head-a' },
      versionToken: 'head-a',
      queueRun: { reason: 'review-request' }
    }
    const result = ledger.ingestObservation(input, ledger.getConfig().configRevision, 0)
    if (!result.ok || result.duplicate || result.runId === null) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result.runId
  }

  function coordinatorWith(
    analyse: Parameters<typeof createForgeInboxCoordinator>[0]['analyse'],
    limits?: Parameters<typeof createForgeInboxCoordinator>[0]['limits']
  ) {
    return createForgeInboxCoordinator({ ledger, scope: SCOPE, analyse, limits })
  }

  it('records the analysed result and the session it came from', async () => {
    const coordinator = coordinatorWith(async ({ bindSession }) => {
      bindSession('session-1')
      return {
        kind: 'analysed',
        result: { summary: 'One nit.', concerns: ['no test'], draft: 'LGTM' }
      }
    })

    await expect(coordinator.drainOnce()).resolves.toEqual({
      analysed: 1,
      failed: 0,
      unverifiable: 0,
      cancelled: 0
    })
    expect(ledger.getRun(runId)).toMatchObject({
      state: 'succeeded',
      sessionId: 'session-1',
      result: { summary: 'One nit.', concerns: ['no test'], draft: 'LGTM' }
    })
  })

  it('reports an outcome it cannot prove as unverifiable and never re-sends it', async () => {
    const calls: number[] = []
    const coordinator = coordinatorWith(async ({ run }) => {
      calls.push(run.id)
      return { kind: 'unknown' }
    })

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })

    await expect(coordinator.drainOnce()).resolves.toEqual({
      analysed: 0,
      failed: 0,
      unverifiable: 0,
      cancelled: 0
    })
    expect(calls).toEqual([runId])
  })

  it('fails a thrown analysis with a stable code instead of the error text', async () => {
    const coordinator = coordinatorWith(async () => {
      throw new Error('ECONNRESET token=glpat-secret')
    })

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'failed', error: 'analysis-failed' })
    expect(JSON.stringify(ledger.getRun(runId))).not.toContain('glpat-secret')
  })

  it('refuses a result larger than the output budget', async () => {
    const coordinator = coordinatorWith(
      async () => ({ kind: 'analysed', result: { summary: 'x'.repeat(200), concerns: [] } }),
      { maxSummaryChars: 100 }
    )

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'failed', error: 'output-budget' })
    expect(ledger.getRun(runId)?.result).toBeNull()
  })

  it('refuses a result whose shape the adapter did not honour', async () => {
    // The adapter output crosses JSON, so the test feeds the same kind of loose value.
    const drifted: ForgeAnalysisResult = JSON.parse('{"summary": 42, "concerns": []}')
    const coordinator = coordinatorWith(async () => ({ kind: 'analysed', result: drifted }))

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'failed', error: 'analysis-failed' })
  })

  it('does not accept an analysis that never bound a session', async () => {
    const coordinator = coordinatorWith(async () => ({
      kind: 'analysed',
      result: { summary: 'Fine.', concerns: [] }
    }))

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'failed', error: 'analysis-failed' })
  })

  it('gives up on a run that outlives its time budget', async () => {
    const coordinator = coordinatorWith(
      ({ signal }) =>
        new Promise<ForgeAnalysisOutcome>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      { runBudgetMs: 20 }
    )

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'unverifiable', error: 'unknown-outcome' })
  })

  it('cancels in-flight work when the host stops', async () => {
    const stopping = new AbortController()
    const coordinator = coordinatorWith(({ signal }) => {
      setTimeout(() => stopping.abort(), 10)
      return new Promise<ForgeAnalysisOutcome>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })

    await coordinator.drainOnce(stopping.signal)
    expect(ledger.getRun(runId)).toMatchObject({ state: 'cancelled', error: 'owner-stopped' })
  })

  it('records the bound session before the analysis settles', async () => {
    let release!: (outcome: ForgeAnalysisOutcome) => void
    const coordinator = coordinatorWith(({ bindSession }) => {
      bindSession('session-2')
      return new Promise<ForgeAnalysisOutcome>((resolve) => {
        release = resolve
      })
    })

    const draining = coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({ state: 'running', sessionId: 'session-2' })
    release({ kind: 'analysed', result: { summary: 'Fine.', concerns: [] } })
    await draining
    expect(ledger.getRun(runId)?.state).toBe('succeeded')
  })

  it('discards a late result when the project rules were revoked mid-run', async () => {
    let release!: (outcome: ForgeAnalysisOutcome) => void
    const coordinator = coordinatorWith(
      () =>
        new Promise<ForgeAnalysisOutcome>((resolve) => {
          release = resolve
        })
    )

    const draining = coordinator.drainOnce()
    ledger.bumpPolicyGeneration(PROJECT)
    release({ kind: 'analysed', result: { summary: 'Late.', concerns: [] } })
    await draining

    expect(ledger.getRun(runId)).toMatchObject({
      state: 'cancelled',
      error: 'policy-revoked',
      result: null
    })
  })

  it('offers a succeeded draft for approval bound to the head the analysis saw', async () => {
    const head = 'a'.repeat(40)
    const proposed: { runId: number; headSha: string | null; body: string }[] = []
    const coordinator = createForgeInboxCoordinator({
      ledger,
      scope: SCOPE,
      analyse: async ({ bindSession }) => {
        bindSession('session-1')
        return {
          kind: 'analysed',
          result: { summary: 'Fine.', concerns: ['no test'], draft: 'Please add a test.' },
          commentDraft: { headSha: head }
        }
      },
      proposeComment: ({ run, headSha, body }) => proposed.push({ runId: run.id, headSha, body })
    })

    await coordinator.drainOnce()
    expect(proposed).toEqual([{ runId, headSha: head, body: 'Please add a test.' }])
    expect(ledger.getRun(runId)?.state).toBe('succeeded')
  })

  it('creates no approval for a draft whose rules were revoked mid-run', async () => {
    let release!: (outcome: ForgeAnalysisOutcome) => void
    let proposed = false
    const coordinator = createForgeInboxCoordinator({
      ledger,
      scope: SCOPE,
      analyse: () =>
        new Promise<ForgeAnalysisOutcome>((resolve) => {
          release = resolve
        }),
      proposeComment: () => {
        proposed = true
      }
    })

    const draining = coordinator.drainOnce()
    ledger.bumpPolicyGeneration(PROJECT)
    release({
      kind: 'analysed',
      result: { summary: 'Late.', concerns: [], draft: 'Too late.' },
      commentDraft: { headSha: 'a'.repeat(40) }
    })
    await draining

    expect(proposed).toBe(false)
    expect(ledger.getRun(runId)?.state).toBe('cancelled')
  })

  it('keeps the analysed result when its approval cannot be recorded', async () => {
    const coordinator = createForgeInboxCoordinator({
      ledger,
      scope: SCOPE,
      analyse: async ({ bindSession }) => {
        bindSession('session-1')
        return {
          kind: 'analysed',
          result: { summary: 'Fine.', concerns: [], draft: 'Please add a test.' },
          commentDraft: { headSha: 'a'.repeat(40) }
        }
      },
      proposeComment: () => {
        throw new Error('ledger unavailable')
      }
    })

    await coordinator.drainOnce()
    expect(ledger.getRun(runId)).toMatchObject({
      state: 'succeeded',
      result: { summary: 'Fine.', concerns: [], draft: 'Please add a test.' }
    })
  })
})
