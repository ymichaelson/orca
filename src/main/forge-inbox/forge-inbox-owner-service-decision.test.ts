import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectEventDecisionResult } from '../../shared/project-event-decision'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'

const RULES = '合并请求需要评审。'

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

/** The fixture binding starts with empty rules; the decision must see the rules written afterwards. */
function replaceRules(fx: OwnerFixture, rules: string): void {
  const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
  try {
    const updated = updateProjectEventPolicy(ledger.ledgerContext(), {
      repoId: 'repo-1',
      expectedGeneration: 1,
      patch: { rules }
    })
    if (!updated.ok) {
      throw new Error(`fixture could not replace the rules: ${updated.reason}`)
    }
  } finally {
    ledger.close()
  }
}

describe('forge inbox owner decision drain', () => {
  let fx: OwnerFixture
  afterEach(() => fx.dispose())

  it('decides a binding delivery the receiver just committed and finishes one that needs nothing more', async () => {
    fx = createOwnerFixture()
    const seen: string[] = []
    const port = await freePort()
    const service = fx.service({
      decideProjectEvent: async (input) => {
        seen.push(input.rules)
        return decided('record_only')
      }
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    replaceRules(fx, RULES)

    const reply = await postHook(port, mergeRequestHookBody(), 'm-1')
    expect(reply.status).toBe(202)
    await service.settled()

    expect(seen).toEqual([RULES])
    expect(fx.deliveries()).toMatchObject([{ state: 'done', body_bytes: 0 }])
    expect(fx.rows('SELECT action FROM project_event_decisions')).toEqual([
      { action: 'record_only' }
    ])
  })

  it('stops before network readiness without claiming or paying', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    let ready!: () => void
    const networkReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    let calls = 0
    const service = fx.service({
      networkReady,
      decideProjectEvent: async () => {
        calls += 1
        return decided('record_only')
      }
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    await postHook(port, mergeRequestHookBody(), 'network-gate')
    expect(service.idle()).toBe(false)
    await service.stop()
    ready()
    expect(calls).toBe(0)
    expect(fx.rows('SELECT decision_state, attempts FROM webhook_deliveries')).toEqual([
      { decision_state: 'queued', attempts: 0 }
    ])
  })

  it('joins cancellation during a request, and never records its late successful response', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    let started!: () => void
    const startedGate = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const request = new Promise<void>((resolve) => {
      release = resolve
    })
    let signal: AbortSignal | undefined
    const service = fx.service({
      decideProjectEvent: async (_input, stopping) => {
        signal = stopping
        started()
        await request
        return decided('record_only')
      }
    })
    await service.start()
    await fx.provision(service, listenerOn(port))
    await postHook(port, mergeRequestHookBody(), 'request-gate')
    await startedGate
    expect(service.idle()).toBe(false)
    const stopping = service.stop()
    expect(signal?.aborted).toBe(true)
    release()
    await stopping
    expect(fx.rows('SELECT count(*) AS n FROM project_event_decisions')).toEqual([{ n: 0 }])
    expect(fx.deliveries()).toMatchObject([{ state: 'pending' }])
  })

  it('keeps the delivery when no decision client is wired', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const service = fx.service()
    await service.start()
    await fx.provision(service, listenerOn(port))

    await postHook(port, mergeRequestHookBody(), 'm-1')
    await service.settled()

    expect(fx.deliveries()).toMatchObject([{ state: 'pending' }])
    expect(fx.rows('SELECT count(*) AS n FROM project_event_decisions')).toEqual([{ n: 0 }])
  })
})
