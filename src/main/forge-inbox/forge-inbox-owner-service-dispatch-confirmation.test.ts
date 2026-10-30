import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import type { DispatchReportCapture } from './forge-inbox-dispatch-report'
import type { DispatchConfirmationReader } from './forge-inbox-dispatch-confirmation-reader'
import { seedDispatchRun } from './forge-inbox-dispatch-confirmation-test-kit'
import { upsertProjectBinding } from './forge-inbox-project-binding'
import { transitionForgeRun } from './forge-inbox-runs'
import {
  createOwnerFixture,
  seedLedger,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const REPORT: DispatchReportCapture = {
  status: 'claims',
  mode: 'remote-actions',
  claims: [{ kind: 'comment', target: { kind: 'merge_request', iid: 7 } }]
}

describe('forge inbox owner service dispatch confirmation', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  const held: { ledger: ForgeInboxLedger | null } = { ledger: null }

  function openLedger(): ForgeInboxLedger {
    if (!held.ledger) {
      throw new Error('expected the open ledger')
    }
    return held.ledger
  }

  function bind(ledger: ForgeInboxLedger) {
    const ctx = ledger.ledgerContext()
    const bindingId = randomUUID()
    upsertProjectBinding(ctx, {
      bindingId,
      projectPath: '/repo',
      gitlabHost: 'gitlab.test',
      gitlabPath: 'group/demo',
      gitlabProjectId: 3,
      callbackUrl: `https://orca.example.com/webhooks/gitlab/${bindingId}`
    })
    return { bindingId, gitlabHost: 'gitlab.test', gitlabProjectId: 3 }
  }

  function markerReader(marker: () => string, calls: string[]): () => DispatchConfirmationReader {
    return () => ({
      getCurrentUser: async () => {
        calls.push('getCurrentUser')
        return {
          ok: true,
          complete: true,
          data: { name: 'Ada', username: 'ada', email: null, commit_email: null }
        }
      },
      listMergeRequestNotes: async () => {
        calls.push('listMergeRequestNotes')
        return {
          ok: true,
          complete: true,
          data: [{ id: 1, system: false, author: 'ada', body: marker(), updated_at: 'x' }]
        }
      },
      listIssueNotes: async () => ({ ok: true, complete: true, data: [] }),
      getMergeRequestState: async () => ({ ok: false, code: 'bad-response' }),
      getMergeRequestApprovals: async () => ({ ok: false, code: 'bad-response' })
    })
  }

  function confirmationState(): unknown {
    return fx.rows('SELECT state FROM run_dispatch_confirmations')[0]?.state
  }

  it('checks a settled dispatch left unconfirmed by an earlier owner when it opens', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    held.ledger = null
    const first = fx.service({
      recoverProjectEventRuns: async (opened) => {
        held.ledger = opened
      }
    })
    await first.start()
    const run = seedDispatchRun(openLedger().ledgerContext(), {
      binding: bind(openLedger()),
      storedIid: 70,
      report: REPORT
    })
    await first.stop()
    expect(confirmationState()).toBe('unconfirmed')

    const calls: string[] = []
    let launches = 0
    const second = fx.service({
      createProjectEventDispatchReader: markerReader(() => run.marker, calls),
      launchProjectEventAgent: () => async () => {
        launches += 1
        return { ok: false, code: 'dispatch-failed' }
      }
    })
    await second.start()
    await second.settled()

    expect(confirmationState()).toBe('confirmed')
    expect(calls).toEqual(['getCurrentUser', 'listMergeRequestNotes'])
    expect(launches).toBe(0)
  })

  it('checks a dispatch the moment its run settles while the owner is running', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    held.ledger = null
    let marker = ''
    const calls: string[] = []
    const service = fx.service({
      recoverProjectEventRuns: async (opened) => {
        held.ledger = opened
      },
      createProjectEventDispatchReader: markerReader(() => marker, calls)
    })
    await service.start()
    const ctx = openLedger().ledgerContext()
    const run = seedDispatchRun(ctx, {
      binding: bind(openLedger()),
      storedIid: 71,
      report: REPORT,
      runState: 'running'
    })
    marker = run.marker
    await vi.waitFor(() => expect(calls).toEqual([]))
    expect(confirmationState()).toBe('unconfirmed')

    transitionForgeRun(ctx, run.runId, { to: 'succeeded' })

    await vi.waitFor(() => expect(confirmationState()).toBe('confirmed'))
  })

  it('leaves a settled dispatch unconfirmed when the host cannot read GitLab', async () => {
    fx = createOwnerFixture()
    await seedLedger(fx)
    held.ledger = null
    const service = fx.service({
      recoverProjectEventRuns: async (opened) => {
        held.ledger = opened
      }
    })
    await service.start()
    seedDispatchRun(openLedger().ledgerContext(), {
      binding: bind(openLedger()),
      storedIid: 72,
      report: REPORT
    })
    await service.settled()

    expect(confirmationState()).toBe('unconfirmed')
  })
})
