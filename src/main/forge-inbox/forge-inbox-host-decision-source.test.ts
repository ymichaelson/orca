import { afterEach, describe, expect, it } from 'vitest'
import { mergeRequestHookBody } from './forge-inbox-gitlab-fake-server'
import { startForgeInboxForHost } from './forge-inbox-host-startup'
import type { ForgeInboxOwnerService } from './forge-inbox-owner-service'
import {
  createOwnerFixture,
  freePort,
  listenerOn,
  postHook,
  type OwnerFixture
} from './forge-inbox-owner-service-test-kit'
import { ForgeInboxLedger } from './forge-inbox-ledger'
import { updateProjectEventPolicy } from './forge-inbox-project-event-policy'

const RULES = '合并请求需要评审。'

describe('forge inbox host decision source', () => {
  let fx: OwnerFixture
  const started: ForgeInboxOwnerService[] = []
  afterEach(async () => {
    for (const service of started.splice(0)) {
      await service.stop()
    }
    await fx.dispose()
  })

  it('decides a committed delivery with the provider and key read at decision time', async () => {
    fx = createOwnerFixture()
    const port = await freePort()
    const seen: { provider: string; key: string; rules: string }[] = []
    let current: {
      provider: 'jev' | 'laya'
      model: string
      baseUrl: string
      apiKey: string
    } = { provider: 'jev', model: '', baseUrl: '', apiKey: 'key-one' }
    const services: ForgeInboxOwnerService[] = []

    await startForgeInboxForHost({
      profileDirectory: fx.root,
      receiverSettings: fx.receiverSettings,
      secretStore: fx.store,
      http: {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          const authorization = new Headers(init?.headers).get('authorization') ?? ''
          seen.push({
            provider: body.model,
            key: authorization,
            rules: String(body.state.project_rules)
          })
          return new Response(
            JSON.stringify({
              model: 'jev-1',
              answers: {
                next_step: {
                  type: 'choice',
                  choice: 'record_only',
                  confidence: 0.9,
                  probabilities: {
                    record_only: 0.9,
                    notify: 0.02,
                    wait: 0.02,
                    fetch_context: 0.02,
                    dispatch_agent: 0.02,
                    ask_user: 0.02
                  }
                }
              },
              usage: { input_tokens: 4, output_tokens: 1 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
      },
      networkReady: Promise.resolve(),
      notify: () => undefined,
      attach: (service) => {
        services.push(service)
        started.push(service)
      },
      decisionSource: {
        read: () => ({ settings: current, apiKey: current.apiKey })
      }
    })
    await fx.provision(services[0]!, listenerOn(port))
    const ledger = ForgeInboxLedger.open(fx.dbPath, { secretStore: fx.store })
    try {
      const updated = updateProjectEventPolicy(ledger.ledgerContext(), {
        repoId: 'repo-1',
        expectedGeneration: 1,
        patch: { rules: RULES }
      })
      if (!updated.ok) {
        throw new Error(`fixture could not set rules: ${updated.reason}`)
      }
    } finally {
      ledger.close()
    }

    current = {
      provider: 'laya',
      model: 'local-model',
      baseUrl: 'https://laya.example.com',
      apiKey: 'key-two'
    }
    const reply = await postHook(port, mergeRequestHookBody(), 'm-1')
    expect(reply.status).toBe(202)
    await services[0]!.settled()

    expect(seen).toEqual([{ provider: 'local-model', key: 'Bearer key-two', rules: RULES }])
    expect(fx.rows('SELECT provider, action FROM project_event_decisions')).toEqual([
      { provider: 'laya', action: 'record_only' }
    ])
  })
})
