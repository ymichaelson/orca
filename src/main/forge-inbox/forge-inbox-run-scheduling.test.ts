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
const HOST_LIMIT = { maxConcurrentRuns: 2 }

function project(projectId: string) {
  return {
    projectId,
    repoId: `repo-${projectId}`,
    workspaceId: 'ws-1',
    agentId: 'codex',
    model: 'gpt-fake',
    enabled: true,
    automaticAnalysis: true
  }
}

describe('forge inbox run scheduling', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([webhookInstance({ projects: [project('42'), project('43'), project('44')] })])
    )
  })
  afterEach(() => harness.dispose())

  function observe(
    projectId: string,
    iid: number,
    token: string,
    key: string,
    queueRun = true
  ): number | null {
    const input: ForgeObservationInput = {
      hostId: 'host-a',
      ...SCOPE,
      projectId,
      kind: 'merge_request',
      iid,
      dedupeKey: key,
      eventKind: 'merge_request.review_requested',
      payload: { token },
      versionToken: token,
      ...(queueRun ? { queueRun: { reason: 'review-request' } } : {})
    }
    const result = ledger.ingestObservation(input, ledger.getConfig().configRevision, 0)
    if (!result.ok || result.duplicate) {
      throw new Error(`unexpected observation outcome ${JSON.stringify(result)}`)
    }
    return result.runId
  }

  it('claims the oldest queued run and marks it running', () => {
    const first = observe('42', 1, 'head-a', 'd-1')
    observe('42', 2, 'head-b', 'd-2')

    expect(ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)?.id).toBe(first)
    expect(ledger.getRun(first ?? 0)?.state).toBe('running')
  })

  it('holds a second run of the same project while one of its runs is live', () => {
    observe('42', 1, 'head-a', 'd-1')
    const second = observe('42', 2, 'head-b', 'd-2')

    expect(ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)).not.toBeNull()
    expect(ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)).toBeNull()
    expect(ledger.getRun(second ?? 0)?.state).toBe('queued')
  })

  it('starts another project while one project is busy', () => {
    observe('42', 1, 'head-a', 'd-1')
    const other = observe('43', 1, 'head-b', 'd-2')

    ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)
    expect(ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)?.id).toBe(other)
  })

  it('stops at the host concurrency budget', () => {
    observe('42', 1, 'head-a', 'd-1')
    observe('43', 1, 'head-b', 'd-2')
    observe('44', 1, 'head-c', 'd-3')

    expect(ledger.claimNextRunnableRun(SCOPE, { maxConcurrentRuns: 2 })).not.toBeNull()
    expect(ledger.claimNextRunnableRun(SCOPE, { maxConcurrentRuns: 2 })).not.toBeNull()
    expect(ledger.claimNextRunnableRun(SCOPE, { maxConcurrentRuns: 2 })).toBeNull()
  })

  it('supersedes a queued run whose head moved on without a new analysis', () => {
    const stale = observe('42', 1, 'head-a', 'd-1')
    observe('42', 1, 'head-b', 'd-2', false)

    expect(ledger.supersedeStaleRuns(SCOPE)).toBe(1)
    expect(ledger.getRun(stale ?? 0)).toMatchObject({ state: 'superseded' })
    expect(ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)).toBeNull()
  })

  it('keeps a queued run whose head is still current', () => {
    const live = observe('42', 1, 'head-a', 'd-1')

    expect(ledger.supersedeStaleRuns(SCOPE)).toBe(0)
    expect(ledger.getRun(live ?? 0)?.state).toBe('queued')
  })

  it('cancels a live run when the project rules change under it', () => {
    observe('42', 1, 'head-a', 'd-1')
    const running = ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)
    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: '42' })

    expect(ledger.cancelRevokedRuns(SCOPE)).toBe(1)
    expect(ledger.getRun(running?.id ?? 0)).toMatchObject({
      state: 'cancelled',
      error: 'policy-revoked'
    })
  })

  it('leaves the live run of another project alone when one project is revoked', () => {
    const revoked = observe('42', 1, 'head-a', 'd-1')
    const kept = observe('43', 1, 'head-b', 'd-2')
    ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)
    ledger.claimNextRunnableRun(SCOPE, HOST_LIMIT)
    ledger.bumpPolicyGeneration({ instanceId: INSTANCE_ID, projectId: '42' })

    expect(ledger.cancelRevokedRuns(SCOPE)).toBe(1)
    expect(ledger.getRun(revoked ?? 0)?.state).toBe('cancelled')
    expect(ledger.getRun(kept ?? 0)?.state).toBe('running')
  })
})
