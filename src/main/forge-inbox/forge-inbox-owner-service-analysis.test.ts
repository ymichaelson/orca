import { afterEach, describe, expect, it } from 'vitest'
import type { ForgeAnalysisOutcome } from './forge-inbox-coordinator'
import type { ForgeInboxLedger } from './forge-inbox-ledger'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  provision,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'

const ANALYSIS_PROJECT = { automaticAnalysis: true, agentId: 'claude', model: 'claude-test' }

function runs(fx: OwnerFixture) {
  return fx.rows('SELECT state, error, session_id, result_json FROM runs ORDER BY id')
}

describe('forge inbox owner analysis drain', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('analyses a queued run and keeps its session and result', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const kinds: string[] = []
    const ledgers: ForgeInboxLedger[] = []
    let revisionAtFactory = -1
    const service = fx.service({
      analyse: (ledger) => {
        ledgers.push(ledger)
        revisionAtFactory = ledger.getConfig().configRevision
        return async ({ run, bindSession }) => {
          kinds.push(run.analysisKind)
          bindSession('session-1')
          return { kind: 'analysed', result: { summary: 'Looks fine', concerns: ['check tests'] } }
        }
      }
    })
    await service.start()
    await provision(service, listenerOn(port), { project: ANALYSIS_PROJECT })

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()

    // The factory builds on the ledger the service opened, before any config was written.
    expect(revisionAtFactory).toBe(0)
    expect(ledgers).toHaveLength(1)
    expect(ledgers[0]!.getConfig().configRevision).toBe(service.getConfig().configRevision)
    expect(ledgers[0]!.getConfig().configRevision).toBeGreaterThan(0)
    expect(kinds).toEqual(['merge_request'])
    expect(runs(fx)).toEqual([
      {
        state: 'succeeded',
        error: null,
        session_id: 'session-1',
        result_json: JSON.stringify({ summary: 'Looks fine', concerns: ['check tests'] })
      }
    ])
  })

  it('leaves the run queued when no adapter is wired', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await provision(service, listenerOn(port), { project: ANALYSIS_PROJECT })

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await service.settled()

    expect(runs(fx)).toEqual([
      { state: 'queued', error: null, session_id: null, result_json: null }
    ])
  })

  it('cancels an in-flight analysis when the host stops', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    let started: () => void = () => undefined
    const analysing = new Promise<void>((resolve) => (started = resolve))
    const service = fx.service({
      analyse:
        () =>
        ({ signal }) =>
          new Promise<ForgeAnalysisOutcome>((resolve) => {
            signal.addEventListener('abort', () => resolve({ kind: 'unknown' }), { once: true })
            started()
          })
    })
    await service.start()
    await provision(service, listenerOn(port), { project: ANALYSIS_PROJECT })

    await postHook(port, mergeRequestHookBody({ reviewers: ['me'] }), 'm-1')
    await analysing
    // A paid run in flight is work, not idleness.
    expect(service.idle()).toBe(false)
    await service.stop()

    expect(runs(fx)).toEqual([
      { state: 'cancelled', error: 'owner-stopped', session_id: null, result_json: null }
    ])
  })
})
