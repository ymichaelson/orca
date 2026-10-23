import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { createForgeProtectedAnalysisRunner } from './forge-inbox-analysis-adapter'
import type { ForgeAnalysisTurn, ForgeAnalysisTurnResult } from './forge-inbox-analysis-runner'
import { createForgeInboxCoordinator } from './forge-inbox-coordinator'
import { SHA_B } from './forge-inbox-gitlab-fake-server'
import {
  API_TOKEN,
  createWorkerRig,
  mergeRequestHookBody,
  type WorkerRig
} from './forge-inbox-webhook-worker-test-kit'

const REPLY = JSON.stringify({ summary: 'Looks fine', concerns: ['check migrations'] })

type TurnCall = { prompt: string; subject: unknown; sessionId: string }

function recordingTurn(text: string = REPLY) {
  const calls: TurnCall[] = []
  const turn: ForgeAnalysisTurn = async ({ prompt, subject, onSession }) => {
    onSession('session-1')
    calls.push({ prompt, subject, sessionId: 'session-1' })
    return { kind: 'reply', text } satisfies ForgeAnalysisTurnResult
  }
  return { calls, turn }
}

function analyse(rig: WorkerRig, turn: ForgeAnalysisTurn) {
  const requests: { url: string; method: string | undefined; token: string | null }[] = []
  const http = {
    fetch: (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method,
        token: new Headers(init?.headers).get('private-token')
      })
      return rig.gitlab.fetch(url)
    }
  }
  const analyseRun = createForgeProtectedAnalysisRunner({ ledger: rig.ledger, http, turn })
  const coordinator = createForgeInboxCoordinator({
    ledger: rig.ledger,
    scope: {},
    analyse: analyseRun
  })
  return { coordinator, requests, drain: () => coordinator.drainOnce() }
}

function runs(rig: WorkerRig) {
  const db = new Database(rig.harness.dbPath)
  try {
    return db.prepare('SELECT state, error, session_id, result_json FROM runs ORDER BY id').all()
  } finally {
    db.close()
  }
}

describe('forge protected analysis runner', () => {
  let rig: WorkerRig
  afterEach(() => rig.dispose())

  async function queueReviewRequest() {
    rig = createWorkerRig()
    rig.admit('merge_request', mergeRequestHookBody({ reviewers: ['me'] }))
    await rig.worker().drainOnce()
    expect(runs(rig)).toEqual([
      { state: 'queued', error: null, session_id: null, result_json: null }
    ])
  }

  it('analyses a queued run from an owner-token snapshot', async () => {
    await queueReviewRequest()
    const { calls, turn } = recordingTurn()
    const { requests, drain } = analyse(rig, turn)

    expect(await drain()).toEqual({ analysed: 1, failed: 0, unverifiable: 0, cancelled: 0 })

    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request.method).toBe('GET')
      expect(request.token).toBe(API_TOKEN)
      expect(request.url).toContain('/api/v4/projects/42/')
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('<item-data>')
    expect(calls[0]?.prompt).toContain('Add thing')
    expect(calls[0]?.prompt).not.toContain(API_TOKEN)
    expect(calls[0]?.subject).toEqual({
      ownerId: rig.ledger.hostId,
      instanceId: 'gitlab-main',
      itemId: '1',
      analysisKind: 'merge_request'
    })
    expect(runs(rig)).toEqual([
      {
        state: 'succeeded',
        error: null,
        session_id: 'session-1',
        result_json: REPLY
      }
    ])
  })

  it('never pays for a run whose head moved after the claim', async () => {
    await queueReviewRequest()
    rig.gitlab.state.mergeRequest.sha = SHA_B
    const { calls, turn } = recordingTurn()

    expect(await analyse(rig, turn).drain()).toEqual({
      analysed: 0,
      failed: 0,
      unverifiable: 1,
      cancelled: 0
    })

    expect(calls).toHaveLength(0)
    expect(runs(rig)).toEqual([
      { state: 'unverifiable', error: 'unknown-outcome', session_id: null, result_json: null }
    ])
  })

  it('fails the run without a turn when the snapshot cannot be read', async () => {
    await queueReviewRequest()
    rig.gitlab.state.override = (path) =>
      path === '/merge_requests/7' ? new Response('{"message":"boom"}', { status: 500 }) : null
    const { calls, turn } = recordingTurn()

    expect(await analyse(rig, turn).drain()).toEqual({
      analysed: 0,
      failed: 1,
      unverifiable: 0,
      cancelled: 0
    })

    expect(calls).toHaveLength(0)
    expect(runs(rig)).toEqual([
      { state: 'failed', error: 'analysis-failed', session_id: null, result_json: null }
    ])
  })
})
