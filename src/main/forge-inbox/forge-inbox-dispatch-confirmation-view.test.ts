import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeLedgerContext } from './forge-inbox-context'
import { ingestForgeEventInTransaction, queueForgeItemRun } from './forge-inbox-ingest'
import { seedDispatchRun } from './forge-inbox-dispatch-confirmation-test-kit'
import {
  dispatchConfirmationView,
  readDispatchConfirmationViews
} from './forge-inbox-dispatch-confirmation-view'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { createForgeOwnerReads } from './forge-inbox-owner-reads'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import { createWebhookHarness, type WebhookHarness } from './forge-inbox-webhook-test-harness'

const SCOPE = { instanceId: 'gitlab:gitlab.test' }
const BINDING = { bindingId: 'binding-1', gitlabHost: 'gitlab.test', gitlabProjectId: 3 }
const MR = { kind: 'merge_request', iid: 7 } as const

const REPORT: DispatchReportCapture = {
  status: 'claims',
  mode: 'remote-actions',
  claims: [
    { kind: 'comment', target: MR },
    { kind: 'approve', target: { kind: 'issue', iid: 9 }, expectedHeadSha: 'a'.repeat(40) }
  ]
}

function evidence(value: unknown): string {
  return JSON.stringify(value)
}

describe('dispatch confirmation view', () => {
  describe('allowlisted projection', () => {
    it('shows the recommendation a person can confirm, with its bounded reason', () => {
      expect(
        dispatchConfirmationView({
          state: 'confirmed',
          reportJson: JSON.stringify({
            ...REPORT,
            recommendation: { action: 'merge', reason: 'Docs only.' }
          }),
          evidenceJson: evidence({
            checkedAt: 9,
            claims: [{ outcome: 'confirmed' }, { outcome: 'confirmed' }]
          })
        })
      ).toMatchObject({ recommendation: { action: 'merge', reason: 'Docs only.' } })
    })

    it('omits the recommendation once the agent never received the prompt', () => {
      expect(
        dispatchConfirmationView({
          state: 'no-claim',
          reportJson: JSON.stringify({
            ...REPORT,
            recommendation: { action: 'merge', reason: 'Docs only.' }
          }),
          evidenceJson: evidence({ claims: [] })
        })
      ).not.toHaveProperty('recommendation')
    })

    it('pairs each reported claim with its checked outcome and keeps only fixed values', () => {
      expect(
        dispatchConfirmationView({
          state: 'contradicted',
          reportJson: JSON.stringify(REPORT),
          evidenceJson: evidence({
            attempts: 2,
            checkedAt: 1234,
            code: 'not-approved',
            claims: [
              {
                kind: 'comment',
                outcome: 'confirmed',
                code: 'marker-note',
                attribution: 'marker-author'
              },
              { kind: 'approve', outcome: 'contradicted', code: 'not-approved', attribution: null }
            ]
          })
        })
      ).toEqual({
        state: 'contradicted',
        checkedAt: 1234,
        code: 'not-approved',
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'confirmed',
            attribution: 'marker-author'
          },
          { kind: 'approve', target: 'issue', iid: 9, outcome: 'contradicted', attribution: null }
        ]
      })
    })

    it('never lets a string the host did not author through', () => {
      const view = dispatchConfirmationView({
        state: 'unconfirmable',
        reportJson: JSON.stringify(REPORT),
        evidenceJson: evidence({
          checkedAt: 'now; rm -rf /',
          code: 'https://evil.example/steal',
          secret: 'glpat-LEAK',
          claims: [
            {
              kind: 'comment',
              outcome: '<script>',
              code: 'x',
              attribution: 'trust-me',
              body: 'leak'
            },
            { kind: 'approve', outcome: 'confirmed', attribution: 'state-only', text: 'leak' }
          ]
        })
      })

      expect(view).toEqual({
        state: 'unconfirmable',
        checkedAt: null,
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'unconfirmable',
            attribution: 'state-only'
          },
          {
            kind: 'approve',
            target: 'issue',
            iid: 9,
            outcome: 'confirmed',
            attribution: 'state-only'
          }
        ]
      })
      expect(JSON.stringify(view)).not.toMatch(/evil|glpat|LEAK|script|rm -rf/)
    })

    it('reads any attribution beyond the marker author as state-only, including an older build one', () => {
      const view = dispatchConfirmationView({
        state: 'confirmed',
        reportJson: JSON.stringify(REPORT),
        evidenceJson: evidence({
          claims: [
            { kind: 'comment', outcome: 'confirmed', attribution: 'merge-user' },
            { kind: 'approve', outcome: 'confirmed', attribution: 'someone-else' }
          ]
        })
      })

      expect(view?.claims.map((claim) => claim.attribution)).toEqual(['state-only', 'state-only'])
    })

    it('shows reported claims as unproven while a check is still open', () => {
      expect(
        dispatchConfirmationView({
          state: 'unconfirmed',
          reportJson: JSON.stringify(REPORT),
          evidenceJson: null
        })
      ).toEqual({
        state: 'unconfirmed',
        checkedAt: null,
        claims: [
          {
            kind: 'comment',
            target: 'merge_request',
            iid: 7,
            outcome: 'unproven',
            attribution: null
          },
          { kind: 'approve', target: 'issue', iid: 9, outcome: 'unproven', attribution: null }
        ]
      })
    })

    it('drops claim lines it cannot pair with evidence rather than guessing', () => {
      const view = dispatchConfirmationView({
        state: 'contradicted',
        reportJson: JSON.stringify(REPORT),
        evidenceJson: evidence({ claims: [{ kind: 'comment', outcome: 'contradicted' }] })
      })

      expect(view?.claims.map((claim) => claim.outcome)).toEqual(['unproven', 'unproven'])
    })

    it('carries a read-only report as no claim with its fixed reason', () => {
      expect(
        dispatchConfirmationView({
          state: 'no-claim',
          reportJson: JSON.stringify({ status: 'claims', mode: 'read-only', claims: [] }),
          evidenceJson: evidence({ checkedAt: 5, code: 'read-only-report', claims: [] })
        })
      ).toEqual({ state: 'no-claim', checkedAt: 5, code: 'read-only-report', claims: [] })
    })

    it('treats a damaged report, damaged evidence and an unknown state safely', () => {
      expect(
        dispatchConfirmationView({ state: 'unconfirmable', reportJson: '{', evidenceJson: '{' })
      ).toEqual({ state: 'unconfirmable', checkedAt: null, claims: [] })
      expect(
        dispatchConfirmationView({ state: 'verified', reportJson: null, evidenceJson: null })
      ).toBeNull()
    })
  })

  describe('reads', () => {
    let harness: WebhookHarness
    let ledger: ForgeInboxLedger
    let ctx: ForgeLedgerContext
    let storedIid = 40

    beforeEach(() => {
      harness = createWebhookHarness()
      ledger = harness.open()
      ctx = ledger.ledgerContext()
    })
    afterEach(() => harness.dispose())

    function seed(report: DispatchReportCapture | null = REPORT) {
      return seedDispatchRun(ctx, { binding: BINDING, storedIid: storedIid++, report })
    }

    it('attaches a view to the run of an item detail and to its timeline entry', () => {
      const { runId, itemId } = seed()

      const detail = createForgeOwnerReads(() => ledger).getItemDetail(SCOPE, itemId, 'client')

      expect(detail?.runs.find((run) => run.id === runId)?.dispatchConfirmation).toMatchObject({
        state: 'unconfirmed',
        claims: [{ kind: 'comment' }, { kind: 'approve' }]
      })
      const entry = detail?.timeline?.find((candidate) => candidate.id === `run:${runId}`)
      expect(entry?.kind === 'run' ? entry.dispatchConfirmation?.state : null).toBe('unconfirmed')
    })

    it('attaches a view to each dispatched run of a runs page, and none to any other run', () => {
      const dispatched = seed()
      const plain = ingestForgeEventInTransaction(ctx, {
        hostId: ctx.hostId,
        instanceId: SCOPE.instanceId,
        projectId: 'group/demo',
        kind: 'merge_request',
        iid: 900,
        dedupeKey: 'plain',
        eventKind: 'Merge Request Hook',
        versionToken: 'v-plain',
        sourceOrder: 1,
        payload: {}
      })
      if (plain.duplicate) {
        throw new Error('fixture expected a first delivery')
      }
      const plainRun = queueForgeItemRun(ctx, plain.itemId, 'review-request')

      const page = createForgeOwnerReads(() => ledger).listRuns(SCOPE, {})

      const byId = new Map(page.rows.map((run) => [run.id, run]))
      expect(byId.get(dispatched.runId)?.dispatchConfirmation?.state).toBe('unconfirmed')
      expect(plainRun).not.toBeNull()
      expect(Object.keys(byId.get(plainRun ?? 0) ?? {})).not.toContain('dispatchConfirmation')
    })

    it('exposes neither the marker nor the stored report text', () => {
      const { runId, itemId, marker } = seed()
      ctx.db
        .prepare('UPDATE run_dispatch_confirmations SET evidence_json = ? WHERE run_id = ?')
        .run(evidence({ claims: [], code: 'agent-unfinished', note: marker }), runId)

      const detail = createForgeOwnerReads(() => ledger).getItemDetail(SCOPE, itemId, 'client')

      const wire = JSON.stringify(detail)
      expect(wire).not.toContain('orca-run')
      expect(wire).not.toContain(marker)
      expect(wire).not.toContain('session-1')
    })

    it('reads only this host and only the asked runs', () => {
      const first = seed()
      const second = seed()

      expect([...readDispatchConfirmationViews(ctx, [first.runId]).keys()]).toEqual([first.runId])
      expect(readDispatchConfirmationViews(ctx, [])).toEqual(new Map())
      ctx.db
        .prepare("UPDATE run_dispatch_confirmations SET host_id = 'other' WHERE run_id = ?")
        .run(second.runId)
      expect(readDispatchConfirmationViews(ctx, [second.runId]).size).toBe(0)
    })
  })
})
