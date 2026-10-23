import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const project = {
  projectId: '42',
  repoId: 'repo-1',
  workspaceId: 'ws-1',
  agentId: 'codex',
  model: 'gpt-fake',
  enabled: true,
  automaticAnalysis: true
}

/** A review request for the same MR whose head is `token`. */
function observation(token: string, key: string): ForgeObservationInput {
  return {
    hostId: 'host-a',
    ...SCOPE,
    projectId: '42',
    kind: 'merge_request',
    iid: 7,
    dedupeKey: key,
    eventKind: 'merge_request.review_requested',
    payload: { token },
    versionToken: token,
    queueRun: { reason: 'review-request' }
  }
}

describe('forge inbox analysis claim', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(ledger, webhookConfig([webhookInstance({ projects: [project] })]))
  })
  afterEach(() => harness.dispose())

  function observe(token: string, key: string) {
    const result = ledger.ingestObservation(
      observation(token, key),
      ledger.getConfig().configRevision,
      0
    )
    if (!result.ok || result.duplicate) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result
  }

  it('records the context it was paid for on the run', () => {
    const { runId } = observe('head-a', 'delivery-1')
    expect(runId).not.toBeNull()
    expect(ledger.getRun(runId ?? 0)).toMatchObject({
      contextDigest: 'head-a',
      analysisKind: 'merge_request',
      state: 'queued'
    })
  })

  it('does not requeue a repeat delivery of the head it is already waiting on', () => {
    const first = observe('head-a', 'delivery-1')
    const repeat = observe('head-a', 'delivery-2')

    expect(repeat.runId).toBeNull()
    expect(repeat.revision).toBe(first.revision)
    expect(ledger.getRun(first.runId ?? 0)?.state).toBe('queued')
  })

  it('does not pay twice for a head it already analysed and left', () => {
    const first = observe('head-a', 'delivery-1')
    ledger.claimNextQueuedRun(SCOPE)
    ledger.transitionRun(first.runId ?? 0, { to: 'succeeded' })
    const second = observe('head-b', 'delivery-2')
    const back = observe('head-a', 'delivery-3')

    expect(first.runId).not.toBeNull()
    expect(second.runId).not.toBeNull()
    expect(back.runId).toBeNull()
    // The return to A is still a new revision the inbox shows.
    expect(back.revision).toBeGreaterThan(second.revision)
    expect(ledger.getRun(second.runId ?? 0)?.state).toBe('superseded')
  })

  it('pays for a head whose earlier run was superseded before it ran', () => {
    const first = observe('head-a', 'delivery-1')
    const second = observe('head-b', 'delivery-2')
    const back = observe('head-a', 'delivery-3')

    expect(ledger.getRun(first.runId ?? 0)?.state).toBe('superseded')
    expect(ledger.getRun(second.runId ?? 0)?.state).toBe('superseded')
    expect(back.runId).not.toBeNull()
    expect(ledger.getRun(back.runId ?? 0)).toMatchObject({
      contextDigest: 'head-a',
      state: 'queued'
    })
  })

  it('pays again for the same head when the project rules changed', () => {
    const first = observe('head-a', 'delivery-1')
    const oldGeneration = ledger.getRun(first.runId ?? 0)?.policyGeneration ?? 0
    const patch = { rules: 'stricter rules' }
    expect(
      ledger.updateProjectPolicy(ledger.getConfig().configRevision, { ...PROJECT, patch })
    ).toMatchObject({ ok: true })

    const again = observe('head-a', 'delivery-2')
    expect(again.runId).not.toBeNull()
    expect(ledger.getRun(again.runId ?? 0)?.policyGeneration).toBeGreaterThan(oldGeneration)
  })

  it('does not quietly retry a failed analysis of the same head', () => {
    const { runId } = observe('head-a', 'delivery-1')
    ledger.claimNextQueuedRun(SCOPE)
    ledger.transitionRun(runId ?? 0, { to: 'failed', error: 'agent-failed' })

    expect(observe('head-a', 'delivery-2').runId).toBeNull()
  })

  it('does not quietly retry an unverifiable analysis of the same head', () => {
    const { runId } = observe('head-a', 'delivery-1')
    ledger.claimNextQueuedRun(SCOPE)
    ledger.transitionRun(runId ?? 0, { to: 'unverifiable', error: 'unknown-outcome' })

    expect(observe('head-a', 'delivery-2').runId).toBeNull()
  })
})
