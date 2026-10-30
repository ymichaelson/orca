import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDispatchConfirmation,
  recordDispatchCapture
} from './forge-inbox-dispatch-confirmation'
import type { DispatchConfirmationReader } from './forge-inbox-dispatch-confirmation-reader'
import { reconcileDispatchConfirmations } from './forge-inbox-dispatch-confirmation-reconcile'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { PROJECT_EVENT_DISPATCH_RUN_REASON } from './forge-inbox-project-event-action-dispatch'
import {
  createWebhookHarness,
  INSTANCE_ID,
  PROJECT_ID,
  webhookConfig,
  webhookInstance,
  type WebhookHarness
} from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: INSTANCE_ID }
const SHA = 'a'.repeat(40)
const MR = { kind: 'merge_request', iid: 7 } as const

type Case = {
  name: string
  report: DispatchReportCapture
  reader: (marker: string) => Partial<DispatchConfirmationReader>
  verdict: string
  /** What the run ends as; a failed or cancelled turn still gets reconciled. */
  runState?: 'failed' | 'cancelled'
  /** The alerts the whole run may raise, in total, whichever side goes first. */
  alerts: ('run-succeeded' | 'project-event' | 'run-failed')[]
}

const CONTRADICTED_APPROVAL: Case = {
  name: 'contradicted',
  report: { status: 'claims', mode: 'remote-actions', claims: [{ kind: 'approve', target: MR }] },
  reader: () => ({
    getMergeRequestState: async () => ({
      ok: true,
      complete: true,
      data: { iid: 7, state: 'opened', sha: SHA, targetProjectId: 42, mergedBy: null }
    }),
    getMergeRequestApprovals: async () => ({
      ok: true,
      complete: true,
      data: { approved: false, approvedBy: [], userHasApproved: false }
    })
  }),
  verdict: 'contradicted',
  alerts: ['project-event']
}

const CASES: Case[] = [
  CONTRADICTED_APPROVAL,
  {
    name: 'confirmed',
    report: { status: 'claims', mode: 'remote-actions', claims: [{ kind: 'comment', target: MR }] },
    reader: (marker) => ({
      listMergeRequestNotes: async () => ({
        ok: true,
        complete: true,
        data: [{ id: 1, system: false, author: 'ada', body: marker, updated_at: 'x' }]
      })
    }),
    verdict: 'confirmed',
    alerts: ['run-succeeded']
  },
  {
    name: 'no-claim',
    report: { status: 'claims', mode: 'read-only', claims: [] },
    reader: () => ({}),
    verdict: 'no-claim',
    alerts: ['run-succeeded']
  },
  {
    name: 'unconfirmable',
    report: { status: 'report-missing' },
    reader: () => ({}),
    verdict: 'unconfirmable',
    alerts: ['project-event']
  },
  {
    ...CONTRADICTED_APPROVAL,
    name: 'contradicted on a failed turn',
    runState: 'failed',
    alerts: ['run-failed']
  },
  {
    ...CONTRADICTED_APPROVAL,
    name: 'contradicted on a cancelled turn',
    runState: 'cancelled',
    alerts: ['project-event']
  },
  {
    ...CONTRADICTED_APPROVAL,
    name: 'unconfirmable on a failed turn',
    report: { status: 'report-missing' },
    reader: () => ({}),
    verdict: 'unconfirmable',
    runState: 'failed',
    alerts: ['run-failed']
  },
  {
    name: 'confirmed on a cancelled turn',
    report: { status: 'claims', mode: 'read-only', claims: [] },
    reader: () => ({}),
    verdict: 'no-claim',
    runState: 'cancelled',
    alerts: []
  }
]

describe('dispatch outcome alerts, whichever of processor and reconciler goes first', () => {
  let harness: WebhookHarness
  let ledger: ForgeInboxLedger
  let order = 0

  beforeEach(() => {
    harness = createWebhookHarness()
    ledger = harness.open()
    harness.configure(
      ledger,
      webhookConfig([
        webhookInstance({ projects: [{ projectId: PROJECT_ID, repoId: 'repo-1', enabled: true }] })
      ])
    )
  })
  afterEach(() => harness.dispose())

  function settledDispatch(report: DispatchReportCapture, runState: Case['runState'] = undefined) {
    order += 1
    const ctx = ledger.ledgerContext()
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 42,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    const ingested = ledger.ingestEvent({
      hostId: ledger.hostId,
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      kind: 'merge_request',
      iid: 7,
      dedupeKey: `webhook:msg-${order}`,
      eventKind: 'gitlab.merge_request',
      payload: { passive: true, completeness: { complete: true } },
      versionToken: `sha-7-${order}`,
      sourceOrder: order,
      title: 'Add thing',
      itemState: 'opened',
      queueRun: { reason: PROJECT_EVENT_DISPATCH_RUN_REASON }
    })
    if (ingested.duplicate) {
      throw new Error('fixture event was a duplicate')
    }
    const run = ledger.claimNextQueuedRun(SCOPE)
    if (!run) {
      throw new Error('expected a claimable run')
    }
    const marker = createDispatchConfirmation(ctx, {
      runId: run.id,
      bindingId,
      gitlabHost: 'gitlab.test',
      gitlabProjectId: 42,
      itemKind: 'merge_request',
      itemIid: 7,
      expectedSha: SHA
    })
    recordDispatchCapture(ctx, run.id, {
      sessionId: 's',
      clientMessageId: 'm',
      turnId: 't',
      report
    })
    ledger.transitionRun(
      run.id,
      runState === 'failed'
        ? { to: 'failed', error: 'agent-failure' }
        : { to: runState ?? 'succeeded' }
    )
    return { runId: run.id, marker }
  }

  async function reconcile(testCase: Case, marker: string): Promise<void> {
    const overrides = testCase.reader(marker)
    const reader: DispatchConfirmationReader = {
      getCurrentUser: async () => ({
        ok: true,
        complete: true,
        data: { name: 'Ada', username: 'ada', email: null, commit_email: null }
      }),
      listMergeRequestNotes: async () => ({ ok: true, complete: true, data: [] }),
      listIssueNotes: async () => ({ ok: true, complete: true, data: [] }),
      getMergeRequestState: async () => ({ ok: false, code: 'bad-response' }),
      getMergeRequestApprovals: async () => ({ ok: false, code: 'bad-response' }),
      ...overrides
    }
    await reconcileDispatchConfirmations(ledger.ledgerContext(), { createReader: () => reader })
  }

  function verdictOf(runId: number): unknown {
    return ledger
      .ledgerContext()
      .db.prepare('SELECT state FROM run_dispatch_confirmations WHERE run_id = ?')
      .get(runId)?.state
  }

  describe.each(CASES)('a dispatch that ends $name', (testCase) => {
    const reasons = (alerts: { reason: string; runId?: number }[], runId: number) =>
      alerts.map((alert) => {
        expect(alert.runId).toBe(runId)
        return alert.reason
      })

    it('alerts exactly as expected when the processor claims before the reconciler finalizes', async () => {
      const { runId, marker } = settledDispatch(testCase.report, testCase.runState)
      const early = ledger.notifications.claim().notifications

      await reconcile(testCase, marker)
      const late = ledger.notifications.claim().notifications

      expect(verdictOf(runId)).toBe(testCase.verdict)
      expect(reasons([...early, ...late], runId)).toEqual(testCase.alerts)
      expect(ledger.notifications.claim().notifications).toEqual([])
    })

    it('alerts exactly as expected when the reconciler finalizes before the processor claims', async () => {
      const { runId, marker } = settledDispatch(testCase.report, testCase.runState)

      await reconcile(testCase, marker)
      const claimed = ledger.notifications.claim().notifications

      expect(verdictOf(runId)).toBe(testCase.verdict)
      expect(reasons(claimed, runId)).toEqual(testCase.alerts)
      expect(ledger.notifications.claim().notifications).toEqual([])
    })
  })
})
